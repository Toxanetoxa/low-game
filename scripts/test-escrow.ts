import type { Abi, Address, Hex } from 'viem';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ganache from 'ganache';
import solc from 'solc';
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeErrorResult,
  defineChain,
  encodeFunctionData,
  keccak256,
  numberToHex,
  parseEther,
  stringToHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

type CompilerOutput = {
  errors?: Array<{ severity: string; formattedMessage: string }>;
  contracts?: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
};

async function compileEscrow(): Promise<{ abi: Abi; bytecode: Hex }> {
  const sourceName = 'DuelEscrow.sol';
  const content = await readFile(new URL('../contracts/DuelEscrow.sol', import.meta.url), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { [sourceName]: { content } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'shanghai',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as CompilerOutput;
  const errors = output.errors?.filter((entry) => entry.severity === 'error') ?? [];
  assert.equal(errors.length, 0, errors.map((entry) => entry.formattedMessage).join('\n'));
  const contract = output.contracts?.[sourceName]?.DuelEscrow;
  assert(contract?.evm.bytecode.object, 'DuelEscrow produced no bytecode');
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
}

const provider = ganache.provider({
  chain: { chainId: 31337, hardfork: 'shanghai' },
  wallet: { deterministic: true, totalAccounts: 3, defaultBalance: 10 },
  logging: { quiet: true },
});
const chain = defineChain({
  id: 31337,
  name: 'Local escrow test',
  nativeCurrency: { name: 'Test ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [] } },
});
const transport = custom(provider, { retryCount: 0 });
const publicClient = createPublicClient({ chain, transport, pollingInterval: 10, cacheTime: 0 });
const wallet = createWalletClient({ chain, transport });

const stake = parseEther('0.01');
const rulesHash = keccak256(stringToHex('LOW GAME test rules'));
const Outcome = { unset: 0, creatorWon: 1, opponentWon: 2, draw: 3, refunded: 4 } as const;

async function run(): Promise<void> {
  const { abi, bytecode } = await compileEscrow();
  const accounts = new Map(
    Object.values(provider.getInitialAccounts()).map(({ secretKey }) => {
      const account = privateKeyToAccount(secretKey as Hex);
      return [account.address, account] as const;
    }),
  );
  assert.equal(accounts.size, 3);
  const [creator, opponent, observer] = [...accounts.keys()];

  const deployment = await publicClient.waitForTransactionReceipt({
    hash: await wallet.deployContract({ abi, bytecode, account: accounts.get(creator)!, args: [rulesHash] }),
  });
  assert.equal(deployment.status, 'success');
  assert(deployment.contractAddress, 'Deployment produced no contract address');
  const address: Address = deployment.contractAddress;

  async function read(functionName: string, args: readonly unknown[] = []): Promise<unknown> {
    return publicClient.readContract({ address, abi, functionName, args });
  }

  async function send(account: Address, functionName: string, args: readonly unknown[] = [], value?: bigint) {
    const { request } = await publicClient.simulateContract({
      address,
      abi,
      account: accounts.get(account)!,
      functionName,
      args,
      value,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
    assert.equal(receipt.status, 'success', `${functionName} reverted`);
    return receipt;
  }

  async function expectRevert(
    expected: string,
    account: Address,
    functionName: string,
    args: readonly unknown[] = [],
    value?: bigint,
  ): Promise<void> {
    const data = encodeFunctionData({ abi, functionName, args });
    await assert.rejects(
      provider.request({
        method: 'eth_call',
        params: [
          { from: account, to: address, data, value: value === undefined ? undefined : numberToHex(value) },
          'latest',
        ],
      }),
      (error: unknown) => {
        if (typeof error !== 'object' || error === null || !('data' in error) || typeof error.data !== 'string')
          return false;
        return decodeErrorResult({ abi, data: error.data as Hex }).errorName === expected;
      },
      `${functionName} should revert with ${expected}`,
    );
  }

  async function createDuel(number: number): Promise<Hex> {
    const matchId = `0x${number.toString(16).padStart(32, '0')}` as const;
    const { timestamp } = await publicClient.getBlock();
    const key = await read('matchKey', [creator, matchId]);
    assert(typeof key === 'string' && /^0x[0-9a-f]{64}$/.test(key));
    const args = [matchId, opponent, timestamp + 30n, timestamp + 90n] as const;
    await send(creator, 'createMatch', args, stake);
    await expectRevert('MatchAlreadyExists', creator, 'createMatch', args, stake);
    return key as Hex;
  }

  async function advanceTime(seconds: number): Promise<void> {
    await provider.request({ method: 'evm_increaseTime', params: [seconds] });
    await provider.request({ method: 'evm_mine', params: [] });
  }

  async function expectCredit(account: Address, value: bigint): Promise<void> {
    assert.equal(await read('credits', [account]), value, `Unexpected credit for ${account}`);
  }

  async function expectResult(key: Hex, outcome: number, creatorVote: number, opponentVote: number): Promise<void> {
    const match = await read('matches', [key]);
    assert(Array.isArray(match), 'Match getter did not return a tuple');
    assert.deepEqual(match.slice(6), [outcome, creatorVote, opponentVote]);
  }

  async function confirm(account: Address, key: Hex, outcome: number): Promise<void> {
    await send(account, 'confirmResult', [key, outcome]);
  }

  async function withdrawCredit(account: Address, expected: bigint): Promise<void> {
    const before = await publicClient.getBalance({ address: account });
    const receipt = await send(account, 'withdraw');
    const after = await publicClient.getBalance({ address: account });
    assert.equal(after - before + receipt.gasUsed * receipt.effectiveGasPrice, expected);
    await expectCredit(account, 0n);
    await expectRevert('NothingToWithdraw', account, 'withdraw');
  }

  assert.equal(await read('rulesHash'), rulesHash);

  const winningDuel = await createDuel(1);
  await expectRevert('NotOpponent', observer, 'fundMatch', [winningDuel], stake);
  await expectRevert('InvalidStake', opponent, 'fundMatch', [winningDuel], stake - 1n);
  await expectRevert('InvalidStake', opponent, 'fundMatch', [winningDuel], stake + 1n);
  await expectRevert('MatchNotFunded', creator, 'confirmResult', [winningDuel, Outcome.opponentWon]);
  await expectRevert('RefundNotReady', observer, 'refund', [winningDuel]);
  await send(opponent, 'fundMatch', [winningDuel], stake);
  assert.equal(await publicClient.getBalance({ address }), stake * 2n);
  await expectRevert('AlreadyFunded', opponent, 'fundMatch', [winningDuel], stake);
  await expectRevert('NotPlayer', observer, 'confirmResult', [winningDuel, Outcome.creatorWon]);
  await expectRevert('InvalidOutcome', creator, 'confirmResult', [winningDuel, Outcome.refunded]);
  await confirm(creator, winningDuel, Outcome.opponentWon);
  await expectResult(winningDuel, Outcome.unset, Outcome.opponentWon, Outcome.unset);
  await expectCredit(creator, 0n);
  await expectCredit(opponent, 0n);
  await expectRevert('AlreadyConfirmed', creator, 'confirmResult', [winningDuel, Outcome.opponentWon]);
  await expectRevert('AlreadyConfirmed', creator, 'confirmResult', [winningDuel, Outcome.creatorWon]);
  await confirm(opponent, winningDuel, Outcome.opponentWon);
  await expectResult(winningDuel, Outcome.opponentWon, Outcome.opponentWon, Outcome.opponentWon);
  await expectRevert('MatchAlreadyClosed', creator, 'confirmResult', [winningDuel, Outcome.creatorWon]);
  await expectRevert('MatchAlreadyClosed', observer, 'refund', [winningDuel]);
  await expectCredit(creator, 0n);
  await expectCredit(opponent, stake * 2n);
  await withdrawCredit(opponent, stake * 2n);

  const creatorWins = await createDuel(2);
  await send(opponent, 'fundMatch', [creatorWins], stake);
  await confirm(opponent, creatorWins, Outcome.creatorWon);
  await expectResult(creatorWins, Outcome.unset, Outcome.unset, Outcome.creatorWon);
  await expectCredit(creator, 0n);
  await expectCredit(opponent, 0n);
  await confirm(creator, creatorWins, Outcome.creatorWon);
  await expectResult(creatorWins, Outcome.creatorWon, Outcome.creatorWon, Outcome.creatorWon);
  await expectCredit(creator, stake * 2n);
  await expectCredit(opponent, 0n);
  await withdrawCredit(creator, stake * 2n);

  const unfundedDuel = await createDuel(3);
  await advanceTime(31);
  await expectRevert('FundingExpired', opponent, 'fundMatch', [unfundedDuel], stake);
  await send(observer, 'refund', [unfundedDuel]);
  await expectResult(unfundedDuel, Outcome.refunded, Outcome.unset, Outcome.unset);
  await expectRevert('MatchAlreadyClosed', observer, 'refund', [unfundedDuel]);
  await expectCredit(creator, stake);
  await expectCredit(opponent, 0n);
  await withdrawCredit(creator, stake);

  const expiredDuel = await createDuel(4);
  await send(opponent, 'fundMatch', [expiredDuel], stake);
  await confirm(creator, expiredDuel, Outcome.creatorWon);
  await advanceTime(31);
  await expectRevert('RefundNotReady', observer, 'refund', [expiredDuel]);
  await advanceTime(60);
  await expectRevert('SettlementExpired', opponent, 'confirmResult', [expiredDuel, Outcome.creatorWon]);
  await send(observer, 'refund', [expiredDuel]);
  await expectResult(expiredDuel, Outcome.refunded, Outcome.creatorWon, Outcome.unset);
  await expectCredit(creator, stake);
  await expectCredit(opponent, stake);
  await withdrawCredit(creator, stake);
  await withdrawCredit(opponent, stake);

  const drawnDuel = await createDuel(5);
  await send(opponent, 'fundMatch', [drawnDuel], stake);
  await confirm(creator, drawnDuel, Outcome.draw);
  await confirm(opponent, drawnDuel, Outcome.draw);
  await expectResult(drawnDuel, Outcome.draw, Outcome.draw, Outcome.draw);
  await expectCredit(creator, stake);
  await expectCredit(opponent, stake);
  await withdrawCredit(creator, stake);
  await withdrawCredit(opponent, stake);

  const disputedDuel = await createDuel(6);
  await send(opponent, 'fundMatch', [disputedDuel], stake);
  await confirm(opponent, disputedDuel, Outcome.opponentWon);
  await confirm(creator, disputedDuel, Outcome.creatorWon);
  await expectResult(disputedDuel, Outcome.refunded, Outcome.creatorWon, Outcome.opponentWon);
  await expectRevert('MatchAlreadyClosed', observer, 'refund', [disputedDuel]);
  await expectCredit(creator, stake);
  await expectCredit(opponent, stake);
  await withdrawCredit(creator, stake);
  await withdrawCredit(opponent, stake);
  assert.equal(await publicClient.getBalance({ address }), 0n);
}

try {
  await run();
  console.log('Escrow integration passed on the local in-memory chain.');
} finally {
  await provider.disconnect();
}
