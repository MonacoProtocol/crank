import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  Order,
  MarketMatchingPool,
  AccountData,
  MarketAccount,
  Orders,
  OrderStatus,
} from "@monaco-protocol/client";

import {
  errorLog,
  findPdaWithSeeds,
  getAnchorProvider,
  getCoreProgram,
  log,
} from "./utils";
import { findTradePda } from "@monaco-protocol/client/src/trade";

type MatchingData = {
  marketPK: string;
  outcomeIndex: number;
  price: number;
  forOutcome: boolean;
  isOpen: boolean;
};

export async function matchManually(marketPda: PublicKey) {
  const openOrders = (
    await new Orders(await getCoreProgram())
      .filterByStatus(OrderStatus.Open)
      .filterByMarket(marketPda)
      .fetch()
  ).data.orderAccounts;
  const matchedOrders = (
    await new Orders(await getCoreProgram())
      .filterByStatus(OrderStatus.Matched)
      .filterByMarket(marketPda)
      .fetch()
  ).data.orderAccounts;

  const partiallyMatchedOrders = matchedOrders.filter(
    (order) => order.account.stakeUnmatched.toNumber() > 0,
  );

  await matchOrders(openOrders.concat(partiallyMatchedOrders));
}

export async function match() {
  const openOrders = (
    await new Orders(await getCoreProgram())
      .filterByStatus(OrderStatus.Open)
      .fetch()
  ).data.orderAccounts;
  if (openOrders.length == 0) {
    return;
  }
  const matchedOrders = (
    await new Orders(await getCoreProgram())
      .filterByStatus(OrderStatus.Matched)
      .fetch()
  ).data.orderAccounts;
  const partiallyMatchedOrders = matchedOrders.filter(
    (order) => order.account.stakeUnmatched.toNumber() > 0,
  );

  await matchOrders(openOrders.concat(partiallyMatchedOrders));
}

async function matchOrders(matchableOrders: AccountData<Order>[]) {
  const matchingDataByCreationTimeLatestFirst = matchableOrders.sort(
    (a, b) =>
      b.account.creationTimestamp.toNumber() -
      a.account.creationTimestamp.toNumber(),
  );
  const matchingDataForValidMarkets = await filterOutUnusableMarkets(
    matchingDataByCreationTimeLatestFirst,
  );
  const validMatchingData = generateMatchingData(matchingDataForValidMarkets);

  const matchingDataByMarket: Map<string, MatchingData[]> = new Map<
    string,
    MatchingData[]
  >();
  validMatchingData.forEach((data) => {
    const marketPK = data.marketPK;
    const value = matchingDataByMarket.get(marketPK);
    value == null
      ? matchingDataByMarket.set(marketPK, [data])
      : value.push(data);
  });

  matchingDataByMarket.forEach(async (marketMatchingData, _) => {
    const outcomes = Array.from(
      new Set(marketMatchingData.map((order) => order.outcomeIndex)),
    );

    outcomes.forEach(async (outcome) => {
      const allOrdersForOutcome = marketMatchingData.filter(
        (order) => order.outcomeIndex == outcome,
      );

      for (const openOrder of allOrdersForOutcome.filter(
        (order) => order.isOpen,
      )) {
        const opposingMatchingData = allOrdersForOutcome.filter(
          (data) => data.forOutcome != openOrder.forOutcome,
        );

        try {
          await matchOrder(openOrder, opposingMatchingData);
        } catch (error) {
          errorLog(
            `Market: ${
              openOrder.marketPK
            } - Failed to match order ${JSON.stringify(openOrder)} - ${error}`,
          );
        }
      }
    });
  });
}

async function filterOutUnusableMarkets(
  marketDatas: AccountData<Order>[],
): Promise<Array<AccountData<Order>>> {
  const coreProgram = await getCoreProgram();

  // Old invalid unusable markets will throw an exception when being deserialized
  const uniqueMarkets = Array.from(
    new Set(marketDatas.map((data) => data.account.market.toBase58())),
  );
  const marketPks = await Promise.all(
    uniqueMarkets.map(async (marketPk) => {
      try {
        await coreProgram.account.market.fetch(marketPk);
        return marketPk;
      } catch (e) {
        return;
      }
    }),
  );
  return marketDatas.filter((data) =>
    marketPks.includes(data.account.market.toBase58()),
  );
}

function generateMatchingData(
  validMarketData: AccountData<Order>[],
): MatchingData[] {
  const matchingData = validMarketData.map((accountData) => {
    return {
      marketPK: accountData.account.market.toBase58(),
      outcomeIndex: accountData.account.marketOutcomeIndex,
      price: accountData.account.expectedPrice,
      forOutcome: accountData.account.forOutcome,
      isOpen: Object.prototype.hasOwnProperty.call(
        accountData.account.orderStatus,
        "open",
      ),
    } as MatchingData;
  });

  const set = new Set(matchingData.map((data) => JSON.stringify(data)));
  return [...set].map((item) => JSON.parse(item));
}

async function matchOrder(
  matchingData: MatchingData,
  opposingMatchingData: MatchingData[],
) {
  const coreProgram: Program = await getCoreProgram();

  const priceList = getOpposingPrices(opposingMatchingData, matchingData);
  if (priceList.length == 0) {
    return;
  }

  const {
    marketPda,
    outcomePda,
    currentOrderPoolPda,
    marketMintPda,
    marketEscrowPda,
  } = await getMarketData(matchingData, coreProgram);
  log(`Market: ${marketPda} - Matching order`);

  log(`Market: ${marketPda} - Current matching pool: ${currentOrderPoolPda}`);
  const currentMatchingQueue = await getMatchingQueue(currentOrderPoolPda);
  if (currentMatchingQueue.queuedItems.length == 0) {
    return; // order may have already been matched and dequeued
  }

  const currentOrderPda = currentMatchingQueue.queuedItems[0];
  const currentOrder = (await coreProgram.account.order.fetch(
    currentOrderPda,
  )) as Order;
  log(
    `Market: ${marketPda} - Current order (forOutcome ${currentOrder.forOutcome} outcome ${currentOrder.marketOutcomeIndex} at price ${currentOrder.expectedPrice}): ${currentOrderPda}`,
  );

  const currentOrderMarketPositionPda = await findPdaWithSeeds(
    [currentOrder.purchaser.toBuffer(), marketPda.toBuffer()],
    coreProgram.programId,
  );
  log(
    `Market: ${marketPda} - Current market position: ${currentOrderMarketPositionPda}`,
  );

  const instructions = [] as TransactionInstruction[];
  let currentStakeUnmatched = currentOrder.stakeUnmatched.toNumber();

  for (const price of priceList) {
    const opposingMatchingPoolPda = await findPdaWithSeeds(
      [
        marketPda.toBuffer(),
        Buffer.from(matchingData.outcomeIndex.toString()),
        Buffer.from(price.toFixed(3).toString()),
        Buffer.from((!currentOrder.forOutcome).toString()),
      ],
      coreProgram.programId,
    );
    log(
      `Market: ${marketPda} - Opposing matching pool at price ${price}: ${opposingMatchingPoolPda}`,
    );

    const opposingMatchingQueue = await getMatchingQueue(
      opposingMatchingPoolPda,
    );
    if (opposingMatchingQueue.queuedItems.length == 0) {
      continue;
    }

    let opposingStakeUnmatchedForPrice =
      opposingMatchingQueue.unmatchedLiquidity.toNumber();

    for (const opposingOrderPda of opposingMatchingQueue.queuedItems) {
      const opposingOrder = (await coreProgram.account.order.fetch(
        opposingOrderPda,
      )) as Order;
      log(
        `Market: ${marketPda} - Opposing order (forOutcome ${opposingOrder.forOutcome} outcome ${opposingOrder.marketOutcomeIndex} at price ${opposingOrder.expectedPrice}): ${opposingOrderPda}`,
      );

      const opposingMarketPositionPda = await findPdaWithSeeds(
        [opposingOrder.purchaser.toBuffer(), marketPda.toBuffer()],
        coreProgram.programId,
      );
      log(
        `Market: ${marketPda} - Opposing market position: ${opposingMarketPositionPda}`,
      );

      const againstPurchaserTokenAccount = await getAssociatedTokenAddress(
        marketMintPda,
        currentOrder.forOutcome
          ? opposingOrder.purchaser
          : currentOrder.purchaser,
      );

      const forPurchaserTokenAccount = await getAssociatedTokenAddress(
        marketMintPda,
        currentOrder.forOutcome
          ? currentOrder.purchaser
          : opposingOrder.purchaser,
      );

      const stakeMatched = Math.min(
        currentOrder.stakeUnmatched.toNumber(),
        opposingOrder.stakeUnmatched.toNumber(),
      );

      if (currentOrder.forOutcome) {
        const [tradeForPda, tradeAgainstPda] = (
          await Promise.all([
            findTradePda(coreProgram, opposingOrderPda, currentOrderPda, true),
            findTradePda(coreProgram, opposingOrderPda, currentOrderPda, false),
          ])
        ).map((result) => result.data.tradePk);

        const ix = await getMatchingInstruction(
          coreProgram,
          currentOrderPda,
          opposingOrderPda,
          tradeForPda,
          tradeAgainstPda,
          marketPda,
          currentOrderMarketPositionPda,
          opposingMarketPositionPda,
          outcomePda,
          currentOrderPoolPda,
          opposingMatchingPoolPda,
          againstPurchaserTokenAccount,
          forPurchaserTokenAccount,
          marketMintPda,
          marketEscrowPda,
        );
        instructions.push(ix);
        currentStakeUnmatched -= stakeMatched;
        opposingStakeUnmatchedForPrice -= stakeMatched;
      } else {
        const [tradeForPda, tradeAgainstPda] = (
          await Promise.all([
            findTradePda(coreProgram, currentOrderPda, opposingOrderPda, true),
            findTradePda(coreProgram, currentOrderPda, opposingOrderPda, false),
          ])
        ).map((result) => result.data.tradePk);

        const ix = await getMatchingInstruction(
          coreProgram,
          opposingOrderPda,
          currentOrderPda,
          tradeForPda,
          tradeAgainstPda,
          marketPda,
          opposingMarketPositionPda,
          currentOrderMarketPositionPda,
          outcomePda,
          opposingMatchingPoolPda,
          currentOrderPoolPda,
          againstPurchaserTokenAccount,
          forPurchaserTokenAccount,
          marketMintPda,
          marketEscrowPda,
        );
        instructions.push(ix);
        currentStakeUnmatched -= stakeMatched;
        opposingStakeUnmatchedForPrice -= stakeMatched;
      }

      if (opposingStakeUnmatchedForPrice <= 0) {
        break; // no remaining unmatched stake at this price point
      }
    }

    if (currentStakeUnmatched <= 0) {
      break; // no remaining unmatched stake for the current order
    }
  }

  const ixBatchSize = 3;
  for (let i = 0; i < instructions.length; i += ixBatchSize) {
    await sendRawTransaction(marketPda, instructions.slice(i, i + ixBatchSize));
  }
}

function getOpposingPrices(
  opposingMatchingData: MatchingData[],
  matchingData: MatchingData,
) {
  const priceList = Array.from(
    new Set(
      opposingMatchingData
        .filter((opposingData) =>
          matchingData.forOutcome
            ? opposingData.price >= matchingData.price
            : opposingData.price <= matchingData.price,
        )
        .map((data) => data.price),
    ),
  );
  const sortedPriceAscending = priceList.sort(function (a, b) {
    return a - b;
  });

  // if forOutcome, find match at the largest price first - if against outcome, find matches at the smallest price first
  return matchingData.forOutcome ? sortedPriceAscending.reverse() : priceList;
}

async function getMarketData(matchingData: MatchingData, coreProgram: Program) {
  const marketPda = new PublicKey(matchingData.marketPK);
  const market = (await coreProgram.account.market.fetch(
    marketPda,
  )) as MarketAccount;

  const outcomePda = await findPdaWithSeeds(
    [marketPda.toBuffer(), Buffer.from(matchingData.outcomeIndex.toString())],
    coreProgram.programId,
  );
  const marketMintPda = market.mintAccount;
  const marketEscrowPda = await findPdaWithSeeds(
    [Buffer.from("escrow"), marketPda.toBuffer()],
    coreProgram.programId,
  );

  // find current order
  const currentOrderPoolPda = await findPdaWithSeeds(
    [
      marketPda.toBuffer(),
      Buffer.from(matchingData.outcomeIndex.toString()),
      Buffer.from(matchingData.price.toFixed(3).toString()),
      Buffer.from(matchingData.forOutcome.toString()),
    ],
    coreProgram.programId,
  );

  return {
    marketPda,
    outcomePda,
    currentOrderPoolPda,
    marketMintPda,
    marketEscrowPda,
  };
}

async function getMatchingQueue(poolPda: PublicKey) {
  const coreProgram = await getCoreProgram();
  const matchingPool = (await coreProgram.account.marketMatchingPool.fetch(
    poolPda,
  )) as MarketMatchingPool;
  const queue = matchingPool.orders;

  const frontIndex = queue.front;
  const allItems = queue.items;
  const backIndex = frontIndex + (queue.len % queue.items.length);

  let queuedItems: PublicKey[] = [];
  if (queue.len > 0) {
    if (backIndex <= frontIndex) {
      // queue bridges array
      queuedItems = allItems
        .slice(frontIndex)
        .concat(allItems.slice(0, backIndex));
    } else {
      // queue can be treated as normal array
      queuedItems = allItems.slice(frontIndex, backIndex);
    }
  }

  return {
    queuedItems: queuedItems,
    unmatchedLiquidity: matchingPool.liquidityAmount,
  };
}

async function getMatchingInstruction(
  coreProgram: Program,
  orderFor: PublicKey,
  orderAgainst: PublicKey,
  tradeForPda: PublicKey,
  tradeAgainstPda: PublicKey,
  market: PublicKey,
  marketPositionFor: PublicKey,
  marketPositionAgainst: PublicKey,
  marketOutcome: PublicKey,
  marketMatchingPoolFor: PublicKey,
  marketMatchingPoolAgainst: PublicKey,
  againstPurchaserTokenAccount: PublicKey,
  forPurchaserTokenAccount: PublicKey,
  mint: PublicKey,
  escrow: PublicKey,
) {
  const authorisedOperatorsAccount = await findPdaWithSeeds(
    [Buffer.from("CRANK")],
    coreProgram.programId,
  );
  return coreProgram.instruction.matchOrders({
    accounts: {
      orderFor: orderFor,
      orderAgainst: orderAgainst,
      tradeFor: tradeForPda,
      tradeAgainst: tradeAgainstPda,
      market: market,
      marketPositionFor: marketPositionFor,
      marketPositionAgainst: marketPositionAgainst,
      marketOutcome: marketOutcome,
      marketMatchingPoolFor: marketMatchingPoolFor,
      marketMatchingPoolAgainst: marketMatchingPoolAgainst,
      crankOperator: getAnchorProvider().wallet.publicKey,
      authorisedOperators: authorisedOperatorsAccount,
      purchaserTokenAccountAgainst: againstPurchaserTokenAccount,
      purchaserTokenAccountFor: forPurchaserTokenAccount,
      marketEscrow: escrow,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    },
  });
}

async function sendRawTransaction(
  marketPda: PublicKey,
  instructions: TransactionInstruction[],
) {
  if (instructions.length == 0) {
    return;
  }

  const transaction = new anchor.web3.Transaction();

  instructions.forEach((instruction) => transaction.add(instruction));

  const provider = getAnchorProvider();
  transaction.recentBlockhash = (
    await provider.connection.getLatestBlockhash()
  ).blockhash;
  transaction.feePayer = provider.wallet.publicKey;

  const signedTx = await provider.wallet.signTransaction(transaction);

  try {
    log(`Market: ${marketPda} - Matching ${instructions.length} Orders.`);
    const tx = await provider.connection.sendRawTransaction(
      signedTx.serialize(),
      { maxRetries: 3 },
    );
    await provider.connection.confirmTransaction(tx, "confirmed");
  } catch (error) {
    errorLog(`Market: ${marketPda} - Exception when matching`, error);
  }
}
