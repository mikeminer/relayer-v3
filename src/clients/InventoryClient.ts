import { constants, utils as sdkUtils } from "@across-protocol/sdk-v2";
import {
  bnZero,
  BigNumber,
  winston,
  toBN,
  getNetworkName,
  createFormatFunction,
  blockExplorerLink,
  Contract,
  runTransaction,
  isDefined,
  DefaultLogLevels,
  TransactionResponse,
  AnyObject,
  ERC20,
  TOKEN_SYMBOLS_MAP,
} from "../utils";
import { HubPoolClient, TokenClient, BundleDataClient } from ".";
import { AdapterManager, CrossChainTransferClient } from "./bridges";
import { InventoryConfig, V3Deposit } from "../interfaces";
import lodash from "lodash";
import { CONTRACT_ADDRESSES } from "../common";
import { CombinedRefunds } from "../dataworker/DataworkerUtils";

type TokenDistributionPerL1Token = { [l1Token: string]: { [chainId: number]: BigNumber } };

export type Rebalance = {
  chainId: number;
  l1Token: string;
  thresholdPct: BigNumber;
  targetPct: BigNumber;
  currentAllocPct: BigNumber;
  balance: BigNumber;
  cumulativeBalance: BigNumber;
  amount: BigNumber;
};

const { CHAIN_IDs } = constants;

export class InventoryClient {
  private logDisabledManagement = false;
  private readonly scalar: BigNumber;
  private readonly formatWei: ReturnType<typeof createFormatFunction>;
  private bundleRefundsPromise: Promise<CombinedRefunds[]> = undefined;

  constructor(
    readonly relayer: string,
    readonly logger: winston.Logger,
    readonly inventoryConfig: InventoryConfig,
    readonly tokenClient: TokenClient,
    readonly chainIdList: number[],
    readonly hubPoolClient: HubPoolClient,
    readonly bundleDataClient: BundleDataClient,
    readonly adapterManager: AdapterManager,
    readonly crossChainTransferClient: CrossChainTransferClient,
    readonly simMode = false
  ) {
    this.scalar = sdkUtils.fixedPointAdjustment;
    this.formatWei = createFormatFunction(2, 4, false, 18);
  }

  // Get the total balance across all chains, considering any outstanding cross chain transfers as a virtual balance on that chain.
  getCumulativeBalance(l1Token: string): BigNumber {
    return this.getEnabledChains()
      .map((chainId) => this.getBalanceOnChainForL1Token(chainId, l1Token))
      .reduce((acc, curr) => acc.add(curr), bnZero);
  }

  // Get the balance of a given l1 token on a target chain, considering any outstanding cross chain transfers as a virtual balance on that chain.
  getBalanceOnChainForL1Token(chainId: number | string, l1Token: string): BigNumber {
    // We want to skip any l2 token that is not present in the inventory config.
    chainId = Number(chainId);
    if (chainId !== this.hubPoolClient.chainId && !this._l1TokenEnabledForChain(l1Token, chainId)) {
      return bnZero;
    }

    // If the chain does not have this token (EG BOBA on Optimism) then 0.
    const balance =
      this.tokenClient.getBalance(chainId, this.getDestinationTokenForL1Token(l1Token, chainId)) || bnZero;

    // Consider any L1->L2 transfers that are currently pending in the canonical bridge.
    return balance.add(
      this.crossChainTransferClient.getOutstandingCrossChainTransferAmount(this.relayer, chainId, l1Token)
    );
  }

  // Get the fraction of funds allocated on each chain.
  getChainDistribution(l1Token: string): { [chainId: number]: BigNumber } {
    const cumulativeBalance = this.getCumulativeBalance(l1Token);
    const distribution: { [chainId: number]: BigNumber } = {};
    this.getEnabledChains().forEach((chainId) => {
      // If token doesn't have entry on chain, skip creating an entry for it since we'll likely run into an error
      // later trying to grab the chain equivalent of the L1 token via the HubPoolClient.
      if (chainId === this.hubPoolClient.chainId || this._l1TokenEnabledForChain(l1Token, chainId)) {
        if (cumulativeBalance.gt(bnZero)) {
          distribution[chainId] = this.getBalanceOnChainForL1Token(chainId, l1Token)
            .mul(this.scalar)
            .div(cumulativeBalance);
        }
      }
    });
    return distribution;
  }

  // Get the distribution of all tokens, spread over all chains.
  getTokenDistributionPerL1Token(): TokenDistributionPerL1Token {
    const distributionPerL1Token: TokenDistributionPerL1Token = {};
    this.getL1Tokens().forEach((l1Token) => (distributionPerL1Token[l1Token] = this.getChainDistribution(l1Token)));
    return distributionPerL1Token;
  }

  // Get the balance of a given token on a given chain, including shortfalls and any pending cross chain transfers.
  getCurrentAllocationPct(l1Token: string, chainId: number): BigNumber {
    // If there is nothing over all chains, return early.
    const cumulativeBalance = this.getCumulativeBalance(l1Token);
    if (cumulativeBalance.eq(bnZero)) {
      return bnZero;
    }

    const shortfall = this.getTokenShortFall(l1Token, chainId);
    const currentBalance = this.getBalanceOnChainForL1Token(chainId, l1Token).sub(shortfall);
    // Multiply by scalar to avoid rounding errors.
    return currentBalance.mul(this.scalar).div(cumulativeBalance);
  }

  // Find how short a given chain is for a desired L1Token.
  getTokenShortFall(l1Token: string, chainId: number): BigNumber {
    return this.tokenClient.getShortfallTotalRequirement(chainId, this.getDestinationTokenForL1Token(l1Token, chainId));
  }

  getDestinationTokenForL1Token(l1Token: string, chainId: number | string): string {
    return this.hubPoolClient.getL2TokenForL1TokenAtBlock(l1Token, Number(chainId));
  }

  getEnabledChains(): number[] {
    return this.chainIdList;
  }

  getEnabledL2Chains(): number[] {
    const hubPoolChainId = this.hubPoolClient.chainId;
    return this.getEnabledChains().filter((chainId) => chainId !== hubPoolChainId);
  }

  getL1Tokens(): string[] {
    return (
      Object.keys(this.inventoryConfig.tokenConfig ?? {}) ||
      this.hubPoolClient.getL1Tokens().map((l1Token) => l1Token.address)
    );
  }

  // Decrement Tokens Balance And Increment Cross Chain Transfer
  trackCrossChainTransfer(l1Token: string, rebalance: BigNumber, chainId: number | string): void {
    this.tokenClient.decrementLocalBalance(this.hubPoolClient.chainId, l1Token, rebalance);
    this.crossChainTransferClient.increaseOutstandingTransfer(this.relayer, l1Token, rebalance, Number(chainId));
  }

  async getAllBundleRefunds(): Promise<CombinedRefunds[]> {
    const refunds: CombinedRefunds[] = [];
    const [pendingRefunds, nextBundleRefunds] = await Promise.all([
      this.bundleDataClient.getPendingRefundsFromValidBundles(this.relayer),
      this.bundleDataClient.getNextBundleRefunds(this.relayer),
    ]);
    refunds.push(...pendingRefunds, ...nextBundleRefunds);
    this.logger.debug({
      at: "InventoryClient#getAllBundleRefunds",
      message: "Remaining refunds from last validated bundle (excludes already executed refunds)",
      refunds: pendingRefunds[0],
    });
    if (nextBundleRefunds.length === 2) {
      this.logger.debug({
        at: "InventoryClient#getAllBundleRefunds",
        message: "Refunds from pending bundle",
        refunds: nextBundleRefunds[0],
      });
      this.logger.debug({
        at: "InventoryClient#getAllBundleRefunds",
        message: "Refunds from upcoming bundle",
        refunds: nextBundleRefunds[1],
      });
    } else {
      this.logger.debug({
        at: "InventoryClient#getAllBundleRefunds",
        message: "Refunds from upcoming bundle",
        refunds: nextBundleRefunds[0],
      });
    }
    return refunds;
  }

  // Return the upcoming refunds (in pending and next bundles) on each chain.
  async getBundleRefunds(l1Token: string): Promise<{ [chainId: string]: BigNumber }> {
    let refundsToConsider: CombinedRefunds[] = [];

    // Increase virtual balance by pending relayer refunds from the latest valid bundle and the
    // upcoming bundle. We can assume that all refunds from the second latest valid bundle have already
    // been executed.
    if (!isDefined(this.bundleRefundsPromise)) {
      // @dev Save this as a promise so that other parallel calls to this function don't make the same call.
      this.bundleRefundsPromise = this.getAllBundleRefunds();
    }
    refundsToConsider = lodash.cloneDeep(await this.bundleRefundsPromise);

    return this.getEnabledChains().reduce((refunds: { [chainId: string]: BigNumber }, chainId) => {
      if (!this.hubPoolClient.l2TokenEnabledForL1Token(l1Token, chainId)) {
        refunds[chainId] = toBN(0);
      } else {
        const destinationToken = this.getDestinationTokenForL1Token(l1Token, chainId);
        refunds[chainId] = this.bundleDataClient.getTotalRefund(
          refundsToConsider,
          this.relayer,
          chainId,
          destinationToken
        );
        return refunds;
      }
      return refunds;
    }, {});
  }

  // Work out where a relay should be refunded to optimally manage the bots inventory. If the inventory management logic
  // not enabled then return funds on the chain the deposit was filled on Else, use the following algorithm for each
  // of the origin and destination chain:
  // a) Find the chain virtual balance (current balance + pending relays + pending refunds) minus current shortfall.
  // b) Find the cumulative virtual balance, including the total refunds on all chains and excluding current shortfall.
  // c) Consider the size of a and b post relay (i.e after the relay is paid and all current transfers are settled what
  // will the balances be on the target chain and the overall cumulative balance).
  // d) Use c to compute what the post relay post current in-flight transactions allocation would be. Compare this
  // number to the target threshold and:
  //     If this number is less than the target for the destination chain + rebalance then select destination chain. We
  //     slightly prefer destination to origin chain to support relayer capital efficiency.
  //     Else, if this number is less than the target for the origin chain + rebalance then select origin
  //     chain.
  //     Else, take repayment on the Hub chain for ease of transferring out of L1 to any L2.
  async determineRefundChainId(deposit: V3Deposit, l1Token?: string): Promise<number> {
    const { originChainId, destinationChainId, inputToken, outputToken, outputAmount } = deposit;
    const hubChainId = this.hubPoolClient.chainId;

    if (!this.isInventoryManagementEnabled()) {
      return destinationChainId;
    }

    // The InventoryClient assumes 1:1 equivalency between input and output tokens. At the moment there is no support
    // for disparate output tokens, so if one appears here then something is wrong. Throw hard and fast in that case.
    // In future, fills for disparate output tokens should probably just take refunds on the destination chain and
    // outsource inventory management to the operator.
    if (!this.hubPoolClient.areTokensEquivalent(inputToken, originChainId, outputToken, destinationChainId)) {
      const [srcChain, dstChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];
      throw new Error(
        `Unexpected ${dstChain} output token on ${srcChain} deposit ${deposit.depositId}` +
          ` (${inputToken} != ${outputToken})`
      );
    }
    l1Token ??= this.hubPoolClient.getL1TokenForL2TokenAtBlock(outputToken, destinationChainId);
    // If there is no inventory config for this token then take refund on destination chain.
    // If neither destination chain nor origin chain have a configuration for this token, then take refund on the
    // destination chain.
    const tokenConfig = this.inventoryConfig?.tokenConfig?.[l1Token];
    if (tokenConfig?.[destinationChainId] === undefined && tokenConfig?.[originChainId] === undefined) {
      return destinationChainId;
    }

    const startTime = performance.now();
    // Consider any refunds from executed and to-be executed bundles. If bundle data client doesn't return in
    // time, return an object with zero refunds for all chains.
    const totalRefundsPerChain: { [chainId: string]: BigNumber } = await this.getBundleRefunds(l1Token);
    this.log(`Time taken to get bundle refunds: ${Math.round((performance.now() - startTime) / 1000)}s`, {
      l1Token,
      totalRefundsPerChain,
    });
    const cumulativeRefunds = Object.values(totalRefundsPerChain).reduce((acc, curr) => acc.add(curr), bnZero);
    const cumulativeVirtualBalance = this.getCumulativeBalance(l1Token);

    // Prioritize destination chain repayment over origin chain repayment but prefer both over
    // hub chain repayment if they are under allocated. We don't include hub chain
    // since its the fallback chain if both destination and origin chain are over allocated.
    const chainsToEvaluate = [destinationChainId];
    // Only evaluate origin chain if its not the hub chain.
    if (originChainId !== hubChainId) {
      chainsToEvaluate.push(originChainId);
    }
    for (const _chain of chainsToEvaluate) {
      if (this.inventoryConfig.tokenConfig[l1Token][_chain] === undefined) {
        continue;
      }
      // Destination chain:
      const chainShortfall = this.getTokenShortFall(l1Token, _chain);
      const chainVirtualBalance = this.getBalanceOnChainForL1Token(_chain, l1Token);
      const chainVirtualBalanceWithShortfall = chainVirtualBalance.sub(chainShortfall);
      let cumulativeVirtualBalanceWithShortfall = cumulativeVirtualBalance.sub(chainShortfall);
      // @dev No need to factor in outputAmount when computing origin chain balance since funds only leave relayer
      // on destination chain
      let chainVirtualBalanceWithShortfallPostRelay =
        _chain === destinationChainId
          ? chainVirtualBalanceWithShortfall.sub(outputAmount)
          : chainVirtualBalanceWithShortfall;
      // Add upcoming refunds:
      chainVirtualBalanceWithShortfallPostRelay = chainVirtualBalanceWithShortfallPostRelay.add(
        totalRefundsPerChain[_chain]
      );
      // To correctly compute the allocation % for this destination chain, we need to add all upcoming refunds for the
      // equivalents of l1Token on all chains.
      cumulativeVirtualBalanceWithShortfall = cumulativeVirtualBalanceWithShortfall.add(cumulativeRefunds);
      const cumulativeVirtualBalanceWithShortfallPostRelay = cumulativeVirtualBalanceWithShortfall.sub(outputAmount);

      // Compute what the balance will be on the target chain, considering this relay and the finalization of the
      // transfers that are currently flowing through the canonical bridge.
      const expectedPostRelayAllocation = chainVirtualBalanceWithShortfallPostRelay
        .mul(this.scalar)
        .div(cumulativeVirtualBalanceWithShortfallPostRelay);

      const targetPct = toBN(this.inventoryConfig.tokenConfig[l1Token][_chain].targetPct);
      this.log(
        `Evaluated taking repayment on ${
          _chain === originChainId ? "origin" : "destination"
        } chain ${_chain} for deposit ${deposit.depositId}: ${
          expectedPostRelayAllocation.lte(targetPct) ? "UNDERALLOCATED ✅" : "OVERALLOCATED ❌"
        }`,
        {
          l1Token,
          originChainId,
          destinationChainId,
          chainShortfall,
          chainVirtualBalance,
          chainVirtualBalanceWithShortfall,
          chainVirtualBalanceWithShortfallPostRelay,
          cumulativeVirtualBalance,
          cumulativeVirtualBalanceWithShortfall,
          cumulativeVirtualBalanceWithShortfallPostRelay,
          targetPct,
          expectedPostRelayAllocation,
          chainsToEvaluate,
        }
      );
      if (expectedPostRelayAllocation.lte(targetPct)) {
        return _chain;
      }
    }

    // Neither destination chain nor origin chain allocation percentage are lower than their target so take
    // repayment on the hub chain by default.
    return hubChainId;
  }

  getPossibleRebalances(): Rebalance[] {
    const tokenDistributionPerL1Token = this.getTokenDistributionPerL1Token();
    return this._getPossibleRebalances(tokenDistributionPerL1Token);
  }

  _getPossibleRebalances(tokenDistributionPerL1Token: TokenDistributionPerL1Token): Rebalance[] {
    const rebalancesRequired: Rebalance[] = [];

    // First, compute the rebalances that we would do assuming we have sufficient tokens on L1.
    for (const l1Token of Object.keys(tokenDistributionPerL1Token)) {
      const cumulativeBalance = this.getCumulativeBalance(l1Token);
      if (cumulativeBalance.eq(bnZero)) {
        continue;
      }

      for (const chainId of this.getEnabledL2Chains()) {
        // Skip if there's no configuration for l1Token on chainId. This is the case for BOBA and BADGER
        // as they're not present on all L2s.
        if (!this._l1TokenEnabledForChain(l1Token, chainId)) {
          continue;
        }

        const currentAllocPct = this.getCurrentAllocationPct(l1Token, chainId);
        const { thresholdPct, targetPct } = this.inventoryConfig.tokenConfig[l1Token][chainId];
        if (currentAllocPct.lt(thresholdPct)) {
          const deltaPct = targetPct.sub(currentAllocPct);
          const amount = deltaPct.mul(cumulativeBalance).div(this.scalar);
          const balance = this.tokenClient.getBalance(1, l1Token);
          // Divide by scalar because allocation percent was multiplied by it to avoid rounding errors.
          rebalancesRequired.push({
            chainId,
            l1Token,
            currentAllocPct,
            thresholdPct,
            targetPct,
            balance,
            cumulativeBalance,
            amount,
          });
        }
      }
    }
    return rebalancesRequired;
  }

  // Trigger a rebalance if the current balance on any L2 chain, including shortfalls, is less than the threshold
  // allocation.
  async rebalanceInventoryIfNeeded(): Promise<void> {
    // Note: these types are just used inside this method, so they are declared in-line.
    type ExecutedRebalance = Rebalance & { hash: string };

    const possibleRebalances: Rebalance[] = [];
    const unexecutedRebalances: Rebalance[] = [];
    const executedTransactions: ExecutedRebalance[] = [];
    try {
      if (!this.isInventoryManagementEnabled()) {
        return;
      }
      const tokenDistributionPerL1Token = this.getTokenDistributionPerL1Token();
      this.constructConsideringRebalanceDebugLog(tokenDistributionPerL1Token);

      const rebalancesRequired = this._getPossibleRebalances(tokenDistributionPerL1Token);
      if (rebalancesRequired.length === 0) {
        this.log("No rebalances required");
        return;
      }

      // Next, evaluate if we have enough tokens on L1 to actually do these rebalances.

      for (const rebalance of rebalancesRequired) {
        const { balance, amount, l1Token, chainId } = rebalance;

        // This is the balance left after any assumed rebalances from earlier loop iterations.
        const unallocatedBalance = this.tokenClient.getBalance(this.hubPoolClient.chainId, l1Token);

        // If the amount required in the rebalance is less than the total amount of this token on L1 then we can execute
        // the rebalance to this particular chain. Note that if the sum of all rebalances required exceeds the l1
        // balance then this logic ensures that we only fill the first n number of chains where we can.
        if (amount.lte(unallocatedBalance)) {
          // As a precautionary step before proceeding, check that the token balance for the token we're about to send
          // hasn't changed on L1. It's possible its changed since we updated the inventory due to one or more of the
          // RPC's returning slowly, leading to concurrent/overlapping instances of the bot running.
          const tokenContract = new Contract(l1Token, ERC20.abi, this.hubPoolClient.hubPool.signer);
          const currentBalance = await tokenContract.balanceOf(this.relayer);
          if (!balance.eq(currentBalance)) {
            this.logger.warn({
              at: "InventoryClient",
              message: "🚧 Token balance on Ethereum changed before sending transaction, skipping rebalance",
              l1Token,
              l2ChainId: chainId,
              balance,
              currentBalance,
            });
            continue;
          } else {
            this.logger.debug({
              at: "InventoryClient",
              message: "Token balance in relayer on Ethereum is as expected, sending cross chain transfer",
              l1Token,
              l2ChainId: chainId,
              balance,
            });
            possibleRebalances.push(rebalance);
            // Decrement token balance in client for this chain and increment cross chain counter.
            this.trackCrossChainTransfer(l1Token, amount, chainId);
          }
        } else {
          // Extract unexecutable rebalances for logging.
          unexecutedRebalances.push(rebalance);
        }
      }

      // Extract unexecutable rebalances for logging.

      this.log("Considered inventory rebalances", { rebalancesRequired, possibleRebalances });

      // Finally, execute the rebalances.
      // TODO: The logic below is slow as it waits for each transaction to be included before sending the next one. This
      // should be refactored to enable us to pass an array of transaction objects to the transaction util that then
      // sends each transaction one after the other with incrementing nonce. this will be left for a follow on PR as this
      // is already complex logic and most of the time we'll not be sending batches of rebalance transactions.
      for (const rebalance of possibleRebalances) {
        const { chainId, l1Token, amount } = rebalance;
        const { hash } = await this.sendTokenCrossChain(chainId, l1Token, amount, this.simMode);
        executedTransactions.push({ ...rebalance, hash });
      }

      // Construct logs on the cross-chain actions executed.
      let mrkdwn = "";

      const groupedRebalances = lodash.groupBy(executedTransactions, "chainId");
      for (const [_chainId, rebalances] of Object.entries(groupedRebalances)) {
        const chainId = Number(_chainId);
        mrkdwn += `*Rebalances sent to ${getNetworkName(chainId)}:*\n`;
        for (const { l1Token, amount, targetPct, thresholdPct, cumulativeBalance, hash } of rebalances) {
          const tokenInfo = this.hubPoolClient.getTokenInfoForL1Token(l1Token);
          if (!tokenInfo) {
            throw new Error(`InventoryClient::rebalanceInventoryIfNeeded no L1 token info for token ${l1Token}`);
          }
          const { symbol, decimals } = tokenInfo;
          const formatter = createFormatFunction(2, 4, false, decimals);
          mrkdwn +=
            ` - ${formatter(amount.toString())} ${symbol} rebalanced. This meets target allocation of ` +
            `${this.formatWei(targetPct.mul(100).toString())}% (trigger of ` +
            `${this.formatWei(thresholdPct.mul(100).toString())}%) of the total ` +
            `${formatter(
              cumulativeBalance.toString()
            )} ${symbol} over all chains (ignoring hubpool repayments). This chain has a shortfall of ` +
            `${formatter(this.getTokenShortFall(l1Token, chainId).toString())} ${symbol} ` +
            `tx: ${blockExplorerLink(hash, this.hubPoolClient.chainId)}\n`;
        }
      }

      const groupedUnexecutedRebalances = lodash.groupBy(unexecutedRebalances, "chainId");
      for (const [_chainId, rebalances] of Object.entries(groupedUnexecutedRebalances)) {
        const chainId = Number(_chainId);
        mrkdwn += `*Insufficient amount to rebalance to ${getNetworkName(chainId)}:*\n`;
        for (const { l1Token, balance, cumulativeBalance, amount } of rebalances) {
          const tokenInfo = this.hubPoolClient.getTokenInfoForL1Token(l1Token);
          if (!tokenInfo) {
            throw new Error(`InventoryClient::rebalanceInventoryIfNeeded no L1 token info for token ${l1Token}`);
          }
          const { symbol, decimals } = tokenInfo;
          const formatter = createFormatFunction(2, 4, false, decimals);
          mrkdwn +=
            `- ${symbol} transfer blocked. Required to send ` +
            `${formatter(amount.toString())} but relayer has ` +
            `${formatter(balance.toString())} on L1. There is currently ` +
            `${formatter(this.getBalanceOnChainForL1Token(chainId, l1Token).toString())} ${symbol} on ` +
            `${getNetworkName(chainId)} which is ` +
            `${this.formatWei(tokenDistributionPerL1Token[l1Token][chainId].mul(100).toString())}% of the total ` +
            `${formatter(cumulativeBalance.toString())} ${symbol}.` +
            " This chain's pending L1->L2 transfer amount is " +
            `${formatter(
              this.crossChainTransferClient
                .getOutstandingCrossChainTransferAmount(this.relayer, chainId, l1Token)
                .toString()
            )}.\n`;
        }
      }

      if (mrkdwn) {
        this.log("Executed Inventory rebalances 📒", { mrkdwn }, "info");
      }
    } catch (error) {
      this.log(
        "Something errored during inventory rebalance",
        { error, possibleRebalances, unexecutedRebalances, executedTransactions }, // include all info to help debugging.
        "error"
      );
    }
  }

  async unwrapWeth(): Promise<void> {
    // Note: these types are just used inside this method, so they are declared in-line.
    type ChainInfo = {
      chainId: number;
      unwrapWethThreshold: BigNumber;
      unwrapWethTarget: BigNumber;
      balance: BigNumber;
    };
    type Unwrap = { chainInfo: ChainInfo; amount: BigNumber };
    type ExecutedUnwrap = Unwrap & { hash: string };

    const unwrapsRequired: Unwrap[] = [];
    const unexecutedUnwraps: Unwrap[] = [];
    const executedTransactions: ExecutedUnwrap[] = [];

    try {
      if (!this.isInventoryManagementEnabled()) {
        return;
      }
      const l1Weth = TOKEN_SYMBOLS_MAP.WETH.addresses[this.hubPoolClient.chainId];
      const chains = await Promise.all(
        this.getEnabledChains()
          .map((chainId) => {
            const unwrapWethThreshold =
              this.inventoryConfig.tokenConfig?.[l1Weth]?.[chainId.toString()]?.unwrapWethThreshold;
            const unwrapWethTarget = this.inventoryConfig.tokenConfig?.[l1Weth]?.[chainId.toString()]?.unwrapWethTarget;

            // Ignore chains where ETH isn't the native gas token. Returning null will result in these being filtered.
            if (chainId === CHAIN_IDs.POLYGON || unwrapWethThreshold === undefined || unwrapWethTarget === undefined) {
              return null;
            }
            return { chainId, unwrapWethThreshold, unwrapWethTarget };
          })
          // This filters out all nulls, which removes any chains that are meant to be ignored.
          .filter(isDefined)
          // This map adds the ETH balance to the object.
          .map(async (chainInfo) => ({
            ...chainInfo,
            balance: await this.tokenClient.spokePoolClients[chainInfo.chainId].spokePool.provider.getBalance(
              this.relayer
            ),
          }))
      );

      this.log("Checking WETH unwrap thresholds for chains with thresholds set", { chains });

      chains.forEach((chainInfo) => {
        const { chainId, unwrapWethThreshold, unwrapWethTarget, balance } = chainInfo;
        const l2WethBalance = this.tokenClient.getBalance(chainId, this.getDestinationTokenForL1Token(l1Weth, chainId));

        if (balance.lt(unwrapWethThreshold)) {
          const amountToUnwrap = unwrapWethTarget.sub(balance);
          const unwrap = { chainInfo, amount: amountToUnwrap };
          if (l2WethBalance.gte(amountToUnwrap)) {
            unwrapsRequired.push(unwrap);
          }
          // Extract unexecutable rebalances for logging.
          else {
            unexecutedUnwraps.push(unwrap);
          }
        }
      });

      this.log("Considered WETH unwraps", { unwrapsRequired, unexecutedUnwraps });

      if (unwrapsRequired.length === 0) {
        this.log("No unwraps required");
        return;
      }

      // Finally, execute the unwraps.
      // TODO: The logic below is slow as it waits for each transaction to be included before sending the next one. This
      // should be refactored to enable us to pass an array of transaction objects to the transaction util that then
      // sends each transaction one after the other with incrementing nonce. this will be left for a follow on PR as this
      // is already complex logic and most of the time we'll not be sending batches of rebalance transactions.
      for (const { chainInfo, amount } of unwrapsRequired) {
        const { chainId } = chainInfo;
        const l2Weth = this.getDestinationTokenForL1Token(l1Weth, chainId);
        this.tokenClient.decrementLocalBalance(chainId, l2Weth, amount);
        const receipt = await this._unwrapWeth(chainId, l2Weth, amount);
        executedTransactions.push({ chainInfo, amount, hash: receipt.hash });
      }

      // Construct logs on the cross-chain actions executed.
      let mrkdwn = "";

      for (const { chainInfo, amount, hash } of executedTransactions) {
        const { chainId, unwrapWethTarget, unwrapWethThreshold, balance } = chainInfo;
        mrkdwn += `*Unwraps sent to ${getNetworkName(chainId)}:*\n`;
        const formatter = createFormatFunction(2, 4, false, 18);
        mrkdwn +=
          ` - ${formatter(amount.toString())} WETH rebalanced. This meets target ETH balance of ` +
          `${this.formatWei(unwrapWethTarget.toString())} (trigger of ` +
          `${this.formatWei(unwrapWethThreshold.toString())} ETH), ` +
          `current balance of ${this.formatWei(balance.toString())} ` +
          `tx: ${blockExplorerLink(hash, chainId)}\n`;
      }

      for (const { chainInfo, amount } of unexecutedUnwraps) {
        const { chainId } = chainInfo;
        mrkdwn += `*Insufficient amount to unwrap WETH on ${getNetworkName(chainId)}:*\n`;
        const formatter = createFormatFunction(2, 4, false, 18);
        mrkdwn +=
          "- WETH unwrap blocked. Required to send " +
          `${formatter(amount.toString())} but relayer has ` +
          `${formatter(
            this.tokenClient.getBalance(chainId, this.getDestinationTokenForL1Token(l1Weth, chainId)).toString()
          )} WETH balance.\n`;
      }

      if (mrkdwn) {
        this.log("Executed WETH unwraps 🎁", { mrkdwn }, "info");
      }
    } catch (error) {
      this.log(
        "Something errored during WETH unwrapping",
        { error, unwrapsRequired, unexecutedUnwraps, executedTransactions }, // include all info to help debugging.
        "error"
      );
    }
  }

  constructConsideringRebalanceDebugLog(distribution: { [l1Token: string]: { [chainId: number]: BigNumber } }): void {
    const logData: {
      [symbol: string]: {
        [chainId: number]: {
          actualBalanceOnChain: string;
          virtualBalanceOnChain: string;
          outstandingTransfers: string;
          tokenShortFalls: string;
          proRataShare: string;
        };
      };
    } = {};
    const cumulativeBalances: { [symbol: string]: string } = {};
    Object.entries(distribution).forEach(([l1Token, distributionForToken]) => {
      const tokenInfo = this.hubPoolClient.getTokenInfoForL1Token(l1Token);
      if (tokenInfo === undefined) {
        throw new Error(
          `InventoryClient::constructConsideringRebalanceDebugLog info not found for L1 token ${l1Token}`
        );
      }
      const { symbol, decimals } = tokenInfo;
      const formatter = createFormatFunction(2, 4, false, decimals);
      cumulativeBalances[symbol] = formatter(this.getCumulativeBalance(l1Token).toString());
      logData[symbol] ??= {};

      Object.entries(distributionForToken).forEach(([_chainId, amount]) => {
        const chainId = Number(_chainId);
        logData[symbol][chainId] = {
          actualBalanceOnChain: formatter(
            this.getBalanceOnChainForL1Token(chainId, l1Token)
              .sub(this.crossChainTransferClient.getOutstandingCrossChainTransferAmount(this.relayer, chainId, l1Token))
              .toString()
          ),
          virtualBalanceOnChain: formatter(this.getBalanceOnChainForL1Token(chainId, l1Token).toString()),
          outstandingTransfers: formatter(
            this.crossChainTransferClient
              .getOutstandingCrossChainTransferAmount(this.relayer, chainId, l1Token)
              .toString()
          ),
          tokenShortFalls: formatter(this.getTokenShortFall(l1Token, chainId).toString()),
          proRataShare: this.formatWei(amount.mul(100).toString()) + "%",
        };
      });
    });

    this.log("Considering rebalance", {
      tokenDistribution: logData,
      cumulativeBalances,
      inventoryConfig: this.inventoryConfig,
    });
  }

  async sendTokenCrossChain(
    chainId: number | string,
    l1Token: string,
    amount: BigNumber,
    simMode = false
  ): Promise<TransactionResponse> {
    return await this.adapterManager.sendTokenCrossChain(this.relayer, Number(chainId), l1Token, amount, simMode);
  }

  async _unwrapWeth(chainId: number, _l2Weth: string, amount: BigNumber): Promise<TransactionResponse> {
    const l2Signer = this.tokenClient.spokePoolClients[chainId].spokePool.signer;
    const l2Weth = new Contract(_l2Weth, CONTRACT_ADDRESSES[1].weth.abi, l2Signer);
    this.log("Unwrapping WETH", { amount: amount.toString() });
    return await runTransaction(this.logger, l2Weth, "withdraw", [amount]);
  }

  async setL1TokenApprovals(): Promise<void> {
    if (!this.isInventoryManagementEnabled()) {
      return;
    }
    const l1Tokens = this.getL1Tokens();
    this.log("Checking token approvals", { l1Tokens });
    await this.adapterManager.setL1TokenApprovals(this.relayer, l1Tokens);
  }

  async wrapL2EthIfAboveThreshold(): Promise<void> {
    // If inventoryConfig is defined, there should be a default wrapEtherTarget and wrapEtherThreshold
    // set by RelayerConfig.ts
    if (!this?.inventoryConfig?.wrapEtherThreshold || !this?.inventoryConfig?.wrapEtherTarget) {
      return;
    }
    this.log("Checking ETH->WETH Wrap status");
    await this.adapterManager.wrapEthIfAboveThreshold(this.inventoryConfig, this.simMode);
  }

  async update(): Promise<void> {
    if (!this.isInventoryManagementEnabled()) {
      return;
    }
    await this.crossChainTransferClient.update(this.getL1Tokens());
  }

  isInventoryManagementEnabled(): boolean {
    if (this?.inventoryConfig?.tokenConfig) {
      return true;
    }
    // Use logDisabledManagement to avoid spamming the logs on every check if this module is enabled.
    else if (this.logDisabledManagement == false) {
      this.log("Inventory Management Disabled");
    }
    this.logDisabledManagement = true;
    return false;
  }

  _l1TokenEnabledForChain(l1Token: string, chainId: number): boolean {
    return this.inventoryConfig.tokenConfig?.[l1Token]?.[String(chainId)] !== undefined;
  }

  log(message: string, data?: AnyObject, level: DefaultLogLevels = "debug"): void {
    if (this.logger) {
      this.logger[level]({ at: "InventoryClient", message, ...data });
    }
  }
}
