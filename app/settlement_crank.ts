import {
  AccountData,
  MarketAccount,
  Markets,
  Order,
  Orders,
  OrderStatus,
  MarketStatus,
} from "@monaco-protocol/client";
import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

import {
  errorLog,
  findPdaWithSeeds,
  getAnchorProvider,
  getCoreProgram,
  log,
} from "./utils";

export async function settleManually(marketPK: PublicKey) {
  const coreProgram = await getCoreProgram();
  const market = (await coreProgram.account.market.fetch(
    marketPK,
  )) as MarketAccount;
  await settleOrderForMarket({ publicKey: marketPK, account: market });
}

export async function settle() {
  const data: AccountData<MarketAccount>[] = await getMarketDataForSettlement();
  await Promise.all(
    data.map(async (marketData) => settleOrderForMarket(marketData)),
  );
}

async function getMarketDataForSettlement(): Promise<
  Array<AccountData<MarketAccount>>
> {
  const coreProgram: Program = await getCoreProgram();
  return (
    await new Markets(coreProgram)
      .filterByStatus(MarketStatus.ReadyForSettlement)
      .fetch()
  ).data.markets;
}

async function settleOrderForMarket(marketData: AccountData<MarketAccount>) {
  const coreProgram: Program = await getCoreProgram();

  const marketMatchedOrders = (
    await new Orders(coreProgram)
      .filterByMarket(marketData.publicKey)
      .filterByStatus(OrderStatus.Matched)
      .fetch()
  ).data.orderAccounts;

  const openOrders = (
    await new Orders(coreProgram)
      .filterByMarket(marketData.publicKey)
      .filterByStatus(OrderStatus.Open)
      .fetch()
  ).data.orderAccounts;

  if (marketMatchedOrders.length == 0 && openOrders.length == 0) {
    log(
      `Market: ${marketData.publicKey} - No orders to settle - completing settlement.`,
    );
    const authorisedOperatorsAccount = await findPdaWithSeeds(
      [Buffer.from("CRANK")],
      coreProgram.programId,
    );
    const tx = await coreProgram.methods
      .completeMarketSettlement()
      .accounts({
        market: marketData.publicKey,
        authorisedOperators: authorisedOperatorsAccount,
        crankOperator: getAnchorProvider().wallet.publicKey,
      })
      .rpc();
    log(`Market: ${marketData.publicKey} - Market settlement completed: ${tx}`);
    return;
  }

  log(
    `Market: ${marketData.publicKey} - Settling ${marketMatchedOrders.length} matched and partially matched orders.`,
  );
  await settleOrders(marketData, coreProgram, marketMatchedOrders);

  log(
    `Market: ${marketData.publicKey} - Refunding and closing ${openOrders.length} open orders.`,
  );
  await settleOrders(marketData, coreProgram, openOrders);
}

async function settleOrders(
  marketData: AccountData<MarketAccount>,
  coreProgram: Program,
  orders: AccountData<Order>[],
) {
  if (orders.length == 0) {
    return;
  }
  const provider = getAnchorProvider();
  const authorisedOperatorsAccount = await findPdaWithSeeds(
    [Buffer.from("CRANK")],
    coreProgram.programId,
  );
  const mint = marketData.account.mintAccount;
  const marketEscrow = await findPdaWithSeeds(
    [Buffer.from("escrow"), marketData.publicKey.toBuffer()],
    coreProgram.programId,
  );

  // GENERATE INSTRUCTIONS
  const instructions = [] as TransactionInstruction[];
  for (let x = 0; x < orders.length; x++) {
    const order = orders[x].account;
    const orderKey = orders[x].publicKey;

    const purchaser = order.purchaser;

    const purchaserTokenAccount = await findPdaWithSeeds(
      [purchaser.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    const purchaserMarketPosition = await findPdaWithSeeds(
      [purchaser.toBuffer(), marketData.publicKey.toBuffer()],
      coreProgram.programId,
    );

    const instruction = coreProgram.instruction.settleOrder({
      accounts: {
        tokenProgram: TOKEN_PROGRAM_ID,
        order: orderKey,
        market: marketData.publicKey,
        crankOperator: provider.wallet.publicKey,
        authorisedOperators: authorisedOperatorsAccount,
        purchaserTokenAccount: purchaserTokenAccount,
        purchaser: purchaser,
        marketEscrow: marketEscrow,
        marketPosition: purchaserMarketPosition,
      },
    });

    instructions.push(instruction);
  }

  // GENERATE AND SEND BATCH TRANSACTION
  const maxInstructions = 3;
  let instructionBatch = [] as TransactionInstruction[];
  for (let i = 0; i < instructions.length; i++) {
    const instruction = instructions[i];
    instructionBatch.push(instruction);

    // BATCH LIMIT REACHED - SEND TRANSACTION
    if (
      instructionBatch.length == maxInstructions ||
      i == instructions.length - 1
    ) {
      const transaction = new anchor.web3.Transaction();

      instructionBatch.forEach((instruction) => transaction.add(instruction));

      transaction.recentBlockhash = (
        await provider.connection.getLatestBlockhash()
      ).blockhash;
      transaction.feePayer = provider.wallet.publicKey;

      try {
        const signedTx = await provider.wallet.signTransaction(transaction);
        log(
          `Market: ${marketData.publicKey} - Settling ${instructionBatch.length} Orders.`,
        );
        const tx = await provider.connection.sendRawTransaction(
          signedTx.serialize(),
        );
        log(
          `Market: ${marketData.publicKey} - Settled ${instructionBatch.length} Orders - ${tx}`,
        );
      } catch (error) {
        errorLog(
          `Market: ${
            marketData.publicKey
          } - Exception while batch calling settleOrder and instructions ${JSON.stringify(
            instructionBatch,
          )}: `,
          error,
        );
      }
      instructionBatch = [];
    }
  }

  log(
    `Market: ${marketData.publicKey} - Settled ${instructions.length} Orders.`,
  );
}
