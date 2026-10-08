import { Block, Row } from './uiParts';

export default function OnChainTab(p: any) {
  const { wallet, walletErr, chain, deploying, chainTx, contractAddress, merchantInput,
    fundAmount, payAmount, chainBusy, setMerchantInput, setFundAmount, setPayAmount,
    onConnect, onDeploy, onFund, onSetMaxTx, onPay, onRefresh } = p;
  const eth = (w: bigint | null | undefined) => w == null ? '—' : (Number(w) / 1e18).toFixed(6);
  const btn = 'btn-apay-bg px-4 py-2 rounded-full text-[13px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed';
  const input = 'bg-pp-soft border border-pp-line rounded-md px-2 py-1 text-[13px] font-mono w-40';
  return (
    <div className="space-y-5">
      <div className="panel p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="label">WALLET CONNECTION · SEPOLIA TESTNET</div>
          <span className={`text-[11px] px-2 py-0.5 rounded-full ${wallet ? 'bg-green-500/15 text-green-600 dark:text-green-400' : 'bg-pp-soft text-pp-mut'}`}>
            {wallet ? 'CONNECTED ✓' : 'NOT CONNECTED'}
          </span>
        </div>
        {wallet ? (
          <div className="text-[13px] space-y-1">
            <Row k="Wallet" v={wallet.address} />
            <Row k="Network" v={`Sepolia (chain ${wallet.chainId})`} />
            <Row k="Balance" v={`${(wallet.balance ?? 0).toFixed(5)} ETH`} />
          </div>
        ) : (
          <p className="text-[13px] text-pp-mut">Connect MetaMask to deploy and use the real on-chain escrow. Signing happens inside MetaMask — this app never sees a private key or seed phrase.</p>
        )}
        <button className={btn} disabled={!!wallet} onClick={onConnect}>
          {wallet ? 'Wallet Connected' : '🦊 CONNECT WALLET'}
        </button>
        {walletErr && <p className="text-[12px] text-red-500">{walletErr}</p>}
      </div>

      {wallet && (
        <div className="panel p-5 space-y-4">
          <div className="label">STEP 1 · DEPLOY ESCROW (real transaction, you sign in MetaMask)</div>
          <div className="flex flex-wrap items-center gap-3">
            <input className={input} placeholder="Merchant address 0x…" value={merchantInput} onChange={(e: any) => setMerchantInput(e.target.value)} />
            <button className={btn} disabled={deploying} onClick={onDeploy}>
              {deploying ? 'Deploying…' : 'Deploy SpendOathEscrow'}
            </button>
          </div>
          <p className="text-[12px] text-pp-mut">Paste any second address as the merchant (e.g. another MetaMask account). Deployment is a real Sepolia transaction — approve it in MetaMask.</p>
        </div>
      )}

      {contractAddress && (
        <div className="panel p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="label">ESCROW CONTRACT · LIVE ON SEPOLIA</div>
            <a className="text-[12px] text-[#0066cc] dark:text-[#6cb2ff] underline" target="_blank" rel="noreferrer"
               href={`https://sepolia.etherscan.io/address/${contractAddress}`}>[VIEW ON EXPLORER]</a>
          </div>
          <div className="text-[13px] space-y-1">
            <Row k="Contract" v={contractAddress} />
            <Row k="Owner" v={chain?.owner ?? '…'} />
            <Row k="Merchant" v={chain?.merchant ?? '…'} />
            <Row k="Budget" v={`${eth(chain?.budgetWei)} ETH`} />
            <Row k="Spent" v={`${eth(chain?.spentWei)} ETH`} />
            <Row k="Max / tx" v={`${eth(chain?.maxTxWei)} ETH`} />
            <Row k="Contract ETH" v={`${eth(chain?.balanceWei)} ETH`} />
            <Row k="Authority" v={chain?.active ? 'ACTIVE ✓' : 'PAUSED'} />
          </div>
          <button className="text-[12px] underline text-pp-mut" onClick={onRefresh}>Refresh from chain</button>
        </div>
      )}

      {chain && (chain.budgetWei ?? 0n) > 0n && (
        <div className="panel p-5 space-y-4">
          <div className="label">STEP 2 · AGENT PAYMENT (real on-chain spend under authority)</div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-[13px] text-pp-mut">Amount (ETH)</label>
            <input className={input} value={payAmount} onChange={(e: any) => setPayAmount(e.target.value)} />
            <button className={btn} disabled={!!chainBusy} onClick={onPay}>{chainBusy === 'pay' ? 'Signing…' : 'Pay via Contract'}</button>
            <button className={btn} disabled={!!chainBusy} onClick={onSetMaxTx}>{chainBusy === 'maxtx' ? 'Signing…' : 'Set as Max-Tx'}</button>
          </div>
          <p className="text-[12px] text-pp-mut">The contract enforces: max-tx ceiling, hard budget cap (revert), destination, and idempotency — in Solidity. Try an amount above the budget: MetaMask will predict the revert and the tx cannot go through.</p>
        </div>
      )}

      {contractAddress && (chain?.budgetWei ?? 0n) === 0n && (
        <div className="panel p-5 space-y-4">
          <div className="label">FUND ESCROW (sets the on-chain budget)</div>
          <div className="flex flex-wrap items-center gap-3">
            <input className={input} value={fundAmount} onChange={(e: any) => setFundAmount(e.target.value)} />
            <span className="text-[13px] text-pp-mut">ETH (≈ ${(Number(fundAmount) * 3000).toFixed(0)} demo budget)</span>
            <button className={btn} disabled={!!chainBusy} onClick={onFund}>{chainBusy === 'fund' ? 'Signing…' : 'Fund Escrow'}</button>
          </div>
        </div>
      )}

      {chainTx && (
        <div className="panel p-5 space-y-2">
          <div className="label">LAST ON-CHAIN TRANSACTION</div>
          <div className="text-[13px] space-y-1">
            <Row k="Action" v={chainTx.label} />
            <Row k="Status" v={chainTx.status === 'SUCCESS' ? 'SUCCESS ✓' : chainTx.status} />
            <Row k="Tx hash" v={chainTx.hash} />
          </div>
          <a className="text-[12px] text-[#0066cc] dark:text-[#6cb2ff] underline" target="_blank" rel="noreferrer"
             href={`https://sepolia.etherscan.io/tx/${chainTx.hash}`}>[VIEW ON EXPLORER]</a>
        </div>
      )}

      <div className="panel p-5">
        <Block title="WHY THIS IS REAL ENFORCEMENT">
          <Row k="Authority chain" v="OWNER WALLET → ESCROW CONTRACT → AGENT → FIREWALL → PAYMENT" />
          <Row k="Hard cap" v="Solidity revert ExceedsRemainingBudget — cannot be bypassed" />
          <Row k="Idempotency" v="usedKeys mapping — retry can never double-charge" />
          <Row k="Keys" v="App never touches seed phrase or private key" />
        </Block>
      </div>
    </div>
  );
}
