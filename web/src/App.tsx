import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion, useSpring, useTransform, useMotionValue, animate } from 'framer-motion';
import { ESCROW_BYTECODE } from './escrowBytecode';
import { COMPILED_ABI } from './escrowAbi';
// Use the solc-compiled ABI everywhere (single source of truth, includes constructor).
const ABI = COMPILED_ABI as any;
import OnChainTab from './OnChainTab';
import { api, type AuditEvent, type Dashboard, type Delivery, type Receipt, type Step, type Service, type Txn } from './api';
import { useTheme } from './useTheme';
import * as XLSX from 'xlsx';

/** One click -> real .xlsx of the agent's spending ledger (Sheet1 "Budget" + "Charts" summary sheet). */
function exportBudgetXlsx(policy: { maxBudgetDollars: number; spentDollars: number; remainingDollars: number } | null, txns: Txn[]) {
  const cap = policy?.maxBudgetDollars ?? 0;
  // oldest-first, running balance like the on-screen ledger
  const rows = [...txns].reverse();
  let running = cap;
  const ledger = rows.map((t, i) => {
    const debit = ['PAID', 'DELIVERED', 'VERIFIED'].includes(t.status) ? t.amountDollars : 0;
    running -= debit;
    const status = t.status === 'REJECTED_BUDGET' ? 'OVER_CAP' : t.verification === 'FAILED' ? 'REFUNDED' : t.status;
    return {
      '#': t.id,
      Date: new Date(t.createdAt).toLocaleTimeString(),
      Item: t.service,
      Category: t.provider ?? 'AGENT',
      Note: t.requestId,
      Debit: debit > 0 ? -debit : 0,
      'Running Balance': Number(running.toFixed(2)),
      Status: status,
    };
  });
  const summary = [
    { Metric: 'Budget Cap', USD: cap },
    { Metric: 'Spent', USD: policy?.spentDollars ?? 0 },
    { Metric: 'Remaining', USD: policy?.remainingDollars ?? 0 },
    { Metric: 'Utilization %', USD: cap > 0 ? Math.round(((policy?.spentDollars ?? 0) / cap) * 100) : 0 },
    ...[...txns.reduce((m, t) => {
      if (!['PAID', 'DELIVERED', 'VERIFIED'].includes(t.status)) return m;
      m.set(t.service, (m.get(t.service) ?? 0) + t.amountDollars);
      return m;
    }, new Map<string, number>())].map(([svc, amt]) => ({ Metric: `Spend · ${svc}`, USD: Number(amt.toFixed(2)) })),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ledger), 'Budget');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'Summary');
  XLSX.writeFile(wb, `SpendOath-budget-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

type Tab = 'overview' | 'agent' | 'market' | 'stream' | 'budget' | 'attack' | 'onchain' | 'verify' | 'audit' | 'demo';

const money = (n: number | null | undefined) => `$${(n ?? 0).toFixed(2)}`;

const STATUS_STYLE: Record<string, string> = {
  VERIFIED: 'bg-pp-green/15 text-pp-green',
  CLAIM_VERIFIED: 'bg-pp-green/15 text-pp-green',
  PAID: 'bg-pp-blue/15 text-pp-blue',
  DELIVERED: 'bg-pp-blue/15 text-pp-blue',
  AUTHORIZED: 'bg-pp-blue/15 text-pp-blue',
  PAYMENT_REQUIRED: 'bg-pp-amber/15 text-pp-amber',
  REQUESTED: 'bg-pp-bg text-pp-mut',
  UNVERIFIED: 'bg-pp-bg text-pp-mut',
  REJECTED_BUDGET: 'bg-pp-red/15 text-pp-red',
  REJECTED_DUPLICATE: 'bg-pp-red/15 text-pp-red',
  FAILED: 'bg-pp-red/15 text-pp-red',
  CLAIM_NOT_VERIFIED: 'bg-pp-red/15 text-pp-red',
  EXECUTION_ERROR: 'bg-pp-amber/15 text-pp-amber',
};

function Badge({ s }: { s: string }) {
  return <span className={`chip ${STATUS_STYLE[s] ?? 'bg-pp-bg text-pp-ink'}`}>{s}</span>;
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'market', label: 'Marketplace' },
  { id: 'attack', label: 'Attack Lab' },
  { id: 'onchain', label: 'On-Chain' },
  { id: 'verify', label: 'Verification' },
  { id: 'stream', label: 'Transactions' },
  { id: 'budget', label: 'Budget Sheet' },
  { id: 'audit', label: 'Audit Trail' },
  { id: 'demo', label: 'Demo' },
];

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [tab, setTab] = useState<Tab>('overview');
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [log, setLog] = useState<{ t: string; kind: string; text: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [attackAmount, setAttackAmount] = useState('8');
  const [attackResult, setAttackResult] = useState<any>(null);
  const [labResult, setLabResult] = useState<any>(null);
  // On-chain wallet state (real MetaMask via viem — no keys handled in app code)
  const [wallet, setWallet] = useState<{ address: string; chainId: number; balance?: number } | null>(null);
  const [walletErr, setWalletErr] = useState<string | null>(null);
  const [chain, setChain] = useState<{ contractAddress: string | null; owner: string | null; merchant: string | null; budgetWei: bigint | null; spentWei: bigint | null; maxTxWei: bigint | null; balanceWei: bigint | null; active: boolean | null } | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [chainTx, setChainTx] = useState<{ hash: string; status: string; label: string } | null>(null);
  const [contractAddress, setContractAddress] = useState<string | null>(localStorage.getItem('pp-escrow'));
  const [merchantInput, setMerchantInput] = useState<string>(localStorage.getItem('pp-merchant') ?? '');
  const [fundAmount, setFundAmount] = useState('0.01');
  const [payAmount, setPayAmount] = useState('0.002');
  const [chainBusy, setChainBusy] = useState<string | null>(null);
  const [onchainErr, setOnchainErr] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [lastRetry, setLastRetry] = useState<{ requestId: string; idempotencyKey: string } | null>(null);
  // Apple Pay-style sheet state
  const [sheet, setSheet] = useState<
    | null
    | { phase: 'confirm'; service: Service }
    | { phase: 'processing'; service: Service; promise: Promise<any> }
    | { phase: 'done'; service: Service; ok: boolean; charged: number; verdict: string | null }
  >(null);

  const refresh = useCallback(async () => {
    const [d, a, dl] = await Promise.all([api.dashboard(), api.audit(), api.deliveries()]);
    setDash(d);
    setEvents(a.events);
    setDeliveries(dl.deliveries);
  }, []);

  useEffect(() => {
    refresh().catch((e) => setErr(String(e)));
  }, [refresh]);

  const pushLog = (text: string, kind = 'INFO') =>
    setLog((l) => [{ t: new Date().toLocaleTimeString(), kind, text }, ...l].slice(0, 200));

  const logSteps = (steps?: Step[]) => {
    if (!steps || steps.length === 0) return;
    const entries = steps.map((s) => ({ t: new Date(s.at).toLocaleTimeString(), kind: s.step, text: s.detail }));
    setLog((l) => [...entries.slice().reverse(), ...l].slice(0, 200));
  };

  const guard = async (fn: () => Promise<any>): Promise<any> => {
    setBusy(true);
    setErr(null);
    try {
      return await fn();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(m);
      pushLog(m, 'ERROR');
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const buy = (serviceId: number) =>
    guard(async () => {
      const res = await api.buy(serviceId);
      logSteps(res.steps);
      if (res.outcome === 'NETWORK_FAILURE') {
        setLastRetry({ requestId: res.requestId, idempotencyKey: res.idempotencyKey });
      }
      await refresh();
      return res;
    });

  // Apple Pay-style flow: confirm sheet -> processing -> done, backed by the real API
  const buyWithSheet = (s: Service) => {
    // Re-fetch dashboard right before opening the sheet: service IDs are re-seeded
    // on every Reset, so a stale list would send a dead ID (SERVICE_NOT_FOUND).
    setSheet({ phase: 'confirm', service: s });
    api.dashboard().then((d) => {
      const fresh = d?.services?.find((x: Service) => x.name === s.name);
      if (fresh && fresh.id !== s.id) setSheet((cur) => (cur?.phase === 'confirm' ? { ...cur, service: fresh } : cur));
    }).catch(() => {});
  };

  const confirmSheetBuy = () => {
    if (!sheet || sheet.phase !== 'confirm') return;
    const service = sheet.service;
    const p = (async () => {
      const res = await api.buy(service.id);
      logSteps(res.steps);
      await refresh();
      return res;
    })();
    setSheet({ phase: 'processing', service, promise: p });
    p.then((res: any) => {
      const verdict = res?.receipt?.verification?.verdict ?? res?.receipt?.finalStatus ?? 'VERIFIED';
      setSheet({ phase: 'done', service, ok: true, charged: res?.chargedDollars ?? service.priceDollars, verdict });
      if (res?.outcome === 'NETWORK_FAILURE') setLastRetry({ requestId: res.requestId, idempotencyKey: res.idempotencyKey });
    }).catch((e) => {
      setSheet({ phase: 'done', service, ok: false, charged: 0, verdict: String(e instanceof Error ? e.message : e) });
    });
  };

  const demoRetry = () =>
    guard(async () => {
      const first = await api.buyFail(services[0]?.id ?? 0);
      logSteps(first.steps);
      pushLog(`Attempt 1 charged ${money(first.chargedDollars)} (settled, response lost)`, 'PAID');
      const r = await api.retry(first.requestId, first.idempotencyKey);
      logSteps(r.steps);
      pushLog(`Attempt 2 charged ${money(r.chargedDollars)} — ${r.reason}`, 'NO_SECOND_CHARGE');
      setLastRetry({ requestId: first.requestId, idempotencyKey: first.idempotencyKey });
      await refresh();
    });

  const retryLast = () =>
    guard(async () => {
      if (!lastRetry) {
        pushLog('No pending request to retry — run "Simulate Network Failure" first.', 'INFO');
        return;
      }
      const r = await api.retry(lastRetry.requestId, lastRetry.idempotencyKey);
      logSteps(r.steps);
      await refresh();
    });

  const attack = () =>
    guard(async () => {
      const res = await api.overspend(Number(attackAmount));
      logSteps(res.steps);
      setAttackResult(res);
      await refresh();
      return res;
    });

  const verify = (deliveryId: number) =>
    guard(async () => {
      const res = await api.verify(deliveryId);
      pushLog(`VERA: ${res.vera.verdict} — ${res.vera.observedResult}`, res.deliveryStatus);
      setReceipt(res.receipt);
      await refresh();
    });

  const tamper = (deliveryId: number) =>
    guard(async () => {
      const res = await api.tamper(deliveryId);
      pushLog(`Tampered artifact re-verified: hashValid=${res.verify.hashValid} → ${res.verify.deliveryStatus}`, res.verify.deliveryStatus);
      setReceipt(res.verify.receipt);
      await refresh();
    });

  const viewReceipt = (paymentId: number) =>
    guard(async () => {
      const r = await api.receipt(paymentId);
      setReceipt(r.receipt);
      setTab('verify');
    });

  const reset = () =>
    guard(async () => {
      await api.reset();
      setLastRetry(null);
      setAttackResult(null);
      setReceipt(null);
      setLog([]);
      pushLog('Demo reset — budget restored to $10.00', 'RESET');
      await refresh();
    });

  const policy = dash?.policy ?? null;
  const services = dash?.services ?? [];
  const txns = dash?.transactions ?? [];
  const counts = dash?.counts;
  const util = policy?.utilizationPct ?? 0;

  return (
    <div className="min-h-screen text-pp-ink bg-pp-bg">
      <header className="frosted border-b border-pp-line/70 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-5 py-3 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-[10px] bg-pp-blue text-white flex items-center justify-center font-semibold text-[15px]" style={{ letterSpacing: '-0.02em' }}>P</div>
          <div>
              <div className="font-semibold text-[17px] leading-tight tracking-[-0.02em]">SpendOath</div>
              <div className="text-[12px] text-pp-mut">Verified Agent Commerce — W3A-1</div>
            </div>
          </div>
          <div className="flex-1" />
          <div className="text-right">
            <div className="text-[11px] text-pp-mut">Owner</div>
            <div className="text-sm font-semibold">{dash?.user.name ?? '—'}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-pp-mut">Agent</div>
            <div className="text-sm font-semibold">{dash?.agent.name ?? '—'}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-pp-mut">Remaining</div>
            <div className="text-sm font-bold text-pp-green">{money(policy?.remainingDollars)}</div>
          </div>
          <button
            className="w-9 h-9 rounded-full border border-pp-line flex items-center justify-center hover:opacity-70 transition-opacity"
            onClick={toggleTheme}
            aria-label="Toggle appearance"
            title={theme === 'dark' ? 'Switch to Light' : 'Switch to Dark'}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={theme}
                initial={{ rotate: -90, opacity: 0, scale: 0.6 }}
                animate={{ rotate: 0, opacity: 1, scale: 1 }}
                exit={{ rotate: 90, opacity: 0, scale: 0.6 }}
                transition={{ duration: 0.2 }}
                className="text-[17px] leading-none"
              >
                {theme === 'dark' ? '☀️' : '🌙'}
              </motion.span>
            </AnimatePresence>
          </button>
          <button className="btn-ghost" onClick={reset} disabled={busy}>Reset</button>
        </div>
      </header>

      <nav className="max-w-7xl mx-auto px-5 pt-4 flex gap-1 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`relative px-3.5 py-1.5 rounded-full text-[14px] font-medium transition-colors ${tab === t.id ? 'text-pp-ink' : 'text-pp-mut hover:text-pp-ink'}`}
          >
            {tab === t.id && (
              <motion.span
                layoutId="tab-pill"
                className="absolute inset-0 rounded-full tab-pill-bg shadow-[0_0_0_0_transparent] dark:shadow-none border border-pp-line/60"
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative z-10">{t.label}</span>
          </button>
        ))}
      </nav>

      {err && <div className="max-w-7xl mx-auto px-5 mt-3"><div className="panel border-pp-red/40 p-3 text-pp-red text-sm">{err}</div></div>}

      <main className="max-w-7xl mx-auto px-5 py-5">
        <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
          className="space-y-5"
        >
        {tab === 'overview' && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: 'Hard Budget', value: policy?.maxBudgetDollars ?? 0, accent: 'text-pp-ink', isMoney: true },
                { label: 'Spent', value: policy?.spentDollars ?? 0, accent: 'text-pp-amber', isMoney: true },
                { label: 'Remaining', value: policy?.remainingDollars ?? 0, accent: 'text-pp-green', isMoney: true },
                { label: 'Blocked Attempts', value: counts?.blockedAttempts ?? 0, accent: 'text-pp-red', isMoney: false },
              ].map((st, i) => (
                <motion.div
                  key={st.label}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.06, type: 'spring', stiffness: 300, damping: 26 }}
                >
                  <div className="panel p-4">
                    <div className="label">{st.label}</div>
                    <div className={`text-2xl font-bold mt-1 ${st.accent}`}>
                      {st.isMoney ? <CountUp value={st.value} format={money} /> : <CountUp value={st.value} format={(n) => String(Math.round(n))} />}
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>

            <div className="panel p-5">
              <div className="flex items-center justify-between mb-2">
                <div className="label">Budget Utilization</div>
                <div className="font-mono text-sm">{util}%</div>
              </div>
              <div className="h-3 rounded-full bg-pp-line overflow-hidden">
                <motion.div
                  className={`h-full rounded-full ${util >= 100 ? 'bg-pp-red' : util >= 60 ? 'bg-pp-amber' : 'bg-pp-green'}`}
                  animate={{ width: `${Math.min(util, 100)}%` }}
                  transition={{ type: 'spring', stiffness: 120, damping: 20 }}
                />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5">
                <Mini label="Settled payments" value={String(counts?.settledPayments ?? 0)} />
                <Mini label="VERA-verified deliveries" value={String(counts?.verifiedDeliveries ?? 0)} />
                <Mini label="Failed verifications" value={String(counts?.failedVerifications ?? 0)} />
                <Mini label="Idempotent / dup blocks" value={String(counts?.duplicateBlocks ?? 0)} />
              </div>
            </div>

            <div className="panel p-5">
              <div className="label mb-3">The Boundary</div>
              <div className="grid md:grid-cols-2 gap-5">
                <div className="border border-pp-line rounded-lg p-4">
                  <div className="font-bold text-pp-green mb-1">SPENDOATH — Financial Authority</div>
                  <p className="text-sm text-pp-mut">"Can this agent spend this money?" Hard cap, policy, idempotency and payment enforcement — all decided server-side, outside the agent's reasoning.</p>
                </div>
                <div className="border border-pp-line rounded-lg p-4">
                  <div className="font-bold text-pp-violet mb-1">VERA — Work Verification</div>
                  <p className="text-sm text-pp-mut">"Did it actually receive valid work?" VERA executes checks against the delivered artifact and compares observed behaviour with the provider's claim.</p>
                </div>
              </div>
            </div>
          </>
        )}

        {tab === 'market' && (
          <div className="grid md:grid-cols-2 gap-4">
            {services.map((s) => (
              <div key={s.id} className="panel p-5 flex flex-col">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-bold">{s.name}</div>
                    <div className="text-[11px] text-pp-mut">{s.providerName}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xl font-bold text-pp-green">{money(s.priceDollars)}</div>
                    <div className="text-[10px] font-mono text-pp-violet">VERA: {s.veraMode}</div>
                  </div>
                </div>
                <p className="text-sm text-pp-mut mt-3 flex-1">{s.description}</p>
                <div className="mt-4 flex gap-2">
                  <button className="btn-primary" onClick={() => buyWithSheet(s)} disabled={busy}>Buy via Agent</button>
                  <button
                    className="btn-ghost"
                    disabled={busy}
                    onClick={() =>
                      guard(async () => {
                        const res = await api.buyFail(s.id);
                        logSteps(res.steps);
                        setLastRetry({ requestId: res.requestId, idempotencyKey: res.idempotencyKey });
                        await refresh();
                      })
                    }
                  >
                    Simulate Network Failure
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'onchain' && (() => {
          const chainErr = (e: any) => setOnchainErr(e?.code === 4001 ? 'Rejected in MetaMask.' : String(e?.message ?? e));
          const readChain = async () => {
            if (!contractAddress) return;
            try {
              const W = await import('./wallet');
              const [owner, merchant, budgetWei, spentWei, maxTxWei, active, bal] = await Promise.all([
                W.readWithFallback((pc) => pc.readContract({ address: contractAddress as `0x${string}`, abi: ABI, functionName: 'owner' })),
                W.readWithFallback((pc) => pc.readContract({ address: contractAddress as `0x${string}`, abi: ABI, functionName: 'merchant' })),
                W.readWithFallback((pc) => pc.readContract({ address: contractAddress as `0x${string}`, abi: ABI, functionName: 'budget' })),
                W.readWithFallback((pc) => pc.readContract({ address: contractAddress as `0x${string}`, abi: ABI, functionName: 'spent' })),
                W.readWithFallback((pc) => pc.readContract({ address: contractAddress as `0x${string}`, abi: ABI, functionName: 'maxTransaction' })),
                W.readWithFallback((pc) => pc.readContract({ address: contractAddress as `0x${string}`, abi: ABI, functionName: 'authorityActive' })),
                W.readWithFallback((pc) => pc.getBalance({ address: contractAddress as `0x${string}` })),
              ]);
              setChain({ contractAddress, owner: owner as string, merchant: merchant as string, budgetWei: budgetWei as bigint, spentWei: spentWei as bigint, maxTxWei: maxTxWei as bigint, balanceWei: bal as bigint, active: active as boolean });
            } catch (e) { setOnchainErr(String((e as any)?.message ?? e)); }
          };
          if (contractAddress && !chain && wallet) { readChain(); }
          return (
          <OnChainTab
            wallet={wallet} walletErr={walletErr ?? onchainErr} chain={chain} deploying={deploying} chainTx={chainTx} busy={busy}
            contractAddress={contractAddress} merchantInput={merchantInput} fundAmount={fundAmount} payAmount={payAmount} chainBusy={chainBusy}
            setMerchantInput={setMerchantInput} setFundAmount={setFundAmount} setPayAmount={setPayAmount}
            onConnect={async () => {
              setWalletErr(null); setOnchainErr(null);
              try {
                const { connectWallet, ensureSepolia, hasWallet, walletBalance } = await import('./wallet');
                if (!hasWallet()) { setWalletErr('MetaMask not installed — install the MetaMask browser extension and reload.'); return; }
                const w = await connectWallet();
                await ensureSepolia();
                const bal = await walletBalance(w.address);
                setWallet({ address: w.address, chainId: 11155111, balance: Number(bal) / 1e18 });
              } catch (e: any) { chainErr(e); }
            }}
            onDeploy={async () => {
              setDeploying(true); setChainTx(null); setOnchainErr(null);
              try {
                const W = await import('./wallet');
                if (!merchantInput.startsWith('0x') || merchantInput.length !== 42) throw new Error('Enter the merchant address (0x…) first.');
                localStorage.setItem('pp-merchant', merchantInput);
                const wc = W.walletClient();
                const [account] = await wc.getAddresses();
                const hash = await wc.deployContract({ abi: ABI as any, account, args: [merchantInput], bytecode: ESCROW_BYTECODE });
                setChainTx({ hash, status: 'PENDING', label: 'Deploy SpendOathEscrow on Sepolia' });
                const rcpt = await W.publicClient().waitForTransactionReceipt({ hash });
                setChainTx({ hash, status: rcpt.status.toUpperCase(), label: 'Deploy SpendOathEscrow on Sepolia' });
                if (rcpt.status === 'success' && rcpt.contractAddress) {
                  setContractAddress(rcpt.contractAddress as string);
                  localStorage.setItem('pp-escrow', rcpt.contractAddress as string);
                }
              } catch (e: any) { chainErr(e); } finally { setDeploying(false); }
            }}
            onFund={async () => {
              setChainBusy('fund'); setChainTx(null); setOnchainErr(null);
              try {
                const W = await import('./wallet');
                const wc = W.walletClient();
                const [account] = await wc.getAddresses();
                const hash = await wc.writeContract({ address: contractAddress as `0x${string}`, abi: ABI, functionName: 'fund', account, value: W.eth(fundAmount), chain: null as any });
                setChainTx({ hash, status: 'PENDING', label: `Fund escrow ${fundAmount} ETH` });
                const rcpt = await W.publicClient().waitForTransactionReceipt({ hash });
                setChainTx({ hash, status: rcpt.status.toUpperCase(), label: `Fund escrow ${fundAmount} ETH` });
                if (rcpt.status === 'success') await readChain();
              } catch (e: any) { chainErr(e); } finally { setChainBusy(null); }
            }}
            onSetMaxTx={async () => {
              setChainBusy('maxtx'); setOnchainErr(null);
              try {
                const W = await import('./wallet');
                const wc = W.walletClient();
                const [account] = await wc.getAddresses();
                const hash = await wc.writeContract({ address: contractAddress as `0x${string}`, abi: ABI, functionName: 'setMaxTransaction', args: [W.eth(payAmount)], account });
                setChainTx({ hash, status: 'PENDING', label: `Set max-tx ${payAmount} ETH` });
                const rcpt = await W.publicClient().waitForTransactionReceipt({ hash });
                setChainTx({ hash, status: rcpt.status.toUpperCase(), label: `Set max-tx ${payAmount} ETH` });
                if (rcpt.status === 'success') await readChain();
              } catch (e: any) { chainErr(e); } finally { setChainBusy(null); }
            }}
            onPay={async () => {
              setChainBusy('pay'); setChainTx(null); setOnchainErr(null);
              try {
                const W = await import('./wallet');
                const wc = W.walletClient();
                const [account] = await wc.getAddresses();
                const key = ('0x' + Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
                const hash = await wc.writeContract({
                  address: contractAddress as `0x${string}`, abi: ABI, functionName: 'pay',
                  args: [key, W.eth(payAmount), (chain?.merchant ?? merchantInput) as `0x${string}`], account,
                });
                setChainTx({ hash, status: 'PENDING', label: `Agent payment ${payAmount} ETH → merchant` });
                const rcpt = await W.publicClient().waitForTransactionReceipt({ hash });
                setChainTx({ hash, status: rcpt.status.toUpperCase(), label: `Agent payment ${payAmount} ETH → merchant` });
                if (rcpt.status === 'success') await readChain();
              } catch (e: any) { chainErr(e); } finally { setChainBusy(null); }
            }}
            onRefresh={readChain}
          />
          );
        })()}

        {tab === 'attack' && (
          <>
            <div className="panel p-5">
              <div className="label mb-3">Overspend Attack</div>
              <div className="flex items-end gap-3 flex-wrap">
                <div>
                  <div className="text-[11px] text-pp-mut mb-1">Current remaining</div>
                  <div className="font-mono text-lg text-pp-green">{money(policy?.remainingDollars)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-pp-mut mb-1">Agent attempts to spend ($)</div>
                  <input
                    value={attackAmount}
                    onChange={(e) => setAttackAmount(e.target.value)}
                    className="bg-pp-bg border border-pp-line rounded-lg px-3 py-2 w-32 font-mono"
                  />
                </div>
                <button className="btn-danger" onClick={attack} disabled={busy}>Attempt Overspend</button>
              </div>
              <p className="text-xs text-pp-mut mt-3">The agent is allowed to TRY. The enforcement layer — not the agent — decides.</p>
            </div>

            <div className="panel p-5">
              <div className="label mb-1">SpendOath Attack Lab — 8 attacks, real firewall, zero simulation</div>
              <p className="text-xs text-pp-mut mb-4">Every attack below runs the same backend firewall as real payments. Blocked = $0 charged, no wallet transaction submitted.</p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { id: 'compromised_agent', label: 'Compromised Agent', desc: 'Hijacked agent demands $8' },
                  { id: 'unknown_agent', label: 'Unknown Agent', desc: 'Never registered with SpendOath' },
                  { id: 'spoofed_identity', label: 'Spoofed Identity', desc: 'Claims agent ID, wrong key' },
                  { id: 'fake_client_budget', label: 'Fake Client Budget', desc: 'Client lies: budget 999999' },
                  { id: 'policy_expired', label: 'Expired Policy', desc: 'Authority lapsed' },
                  { id: 'restricted_service', label: 'Restricted Service', desc: 'Service outside allowlist' },
                  { id: 'replay', label: 'Replay Attack', desc: 'Reuses consumed signature' },
                  { id: 'destination_hijack', label: 'Destination Hijack', desc: 'Redirect to attacker wallet' },
                ].map((a) => (
                  <button
                    key={a.id}
                    className="text-left border border-pp-line rounded-xl p-3 hover:border-pp-red/60 hover:bg-pp-red/5 transition-colors disabled:opacity-40"
                    disabled={busy}
                    onClick={() => guard(async () => {
                      const res = await api.attackLab(a.id, a.id === 'compromised_agent' ? 8 : Number(attackAmount) || 8);
                      setLabResult(res);
                      await refresh();
                      return res;
                    })}
                  >
                    <div className="text-sm font-semibold text-pp-ink">{a.label}</div>
                    <div className="text-[11px] text-pp-mut mt-0.5">{a.desc}</div>
                    <div className="mt-2 text-[10px] font-mono text-pp-red">EXECUTE →</div>
                  </button>
                ))}
              </div>
              {labResult && (
                <div className={`mt-4 rounded-xl p-4 font-mono border-2 ${labResult.verdict?.allowed ? 'border-pp-green/50 bg-pp-green/5' : 'border-pp-red/50 bg-pp-red/5'}`}>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="font-bold">{labResult.attack.replace(/_/g, ' ').toUpperCase()}</span>
                    <span className={`text-lg font-bold ${labResult.verdict?.allowed ? 'text-pp-green' : 'text-pp-red'}`}>
                      {labResult.verdict?.decision}
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-pp-mut">Reason: {labResult.verdict?.reason}</div>
                  <div className="mt-1 text-sm">Charged: <span className={labResult.chargedCents ? 'text-pp-green' : 'text-pp-red font-bold'}>${(labResult.chargedCents / 100).toFixed(2)}</span> · Wallet tx: <span className="text-pp-amber">{labResult.walletTransaction}</span> · MetaMask popup: <span className="text-pp-amber">{labResult.metaMaskOpened ? 'YES' : 'NO'}</span></div>
                  {labResult.verdict?.clientClaimsIgnored?.length > 0 && (
                    <div className="mt-1 text-xs text-pp-amber">Ignored client lies: {labResult.verdict.clientClaimsIgnored.join(', ')}</div>
                  )}
                  {labResult.verdict?.checks?.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {labResult.verdict.checks.map((c: any, i: number) => (
                        <div key={i} className="text-xs flex gap-2">
                          <span className={c.result === 'PASS' ? 'text-pp-green' : c.result === 'FAIL' ? 'text-pp-red' : 'text-pp-mut'}>{c.result === 'PASS' ? '✓' : c.result === 'FAIL' ? '✗' : '–'}</span>
                          <span className="text-pp-mut w-24">{c.check}</span>
                          <span>{c.detail}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {attackResult && (
              <div className="panel p-6 border-2 border-pp-red/50 font-mono">
                <div className="text-pp-red font-bold text-lg mb-3">OVERSPEND ATTACK</div>
                <Row k="Requested" v={money(attackResult.requestedDollars)} />
                <Row k="Remaining" v={money(attackResult.remainingDollars)} />
                <div className="my-3 border-t border-pp-line" />
                <div className={`text-xl font-bold ${attackResult.outcome === 'BLOCKED_BUDGET' ? 'text-pp-red' : 'text-pp-green'}`}>
                  RESULT: {attackResult.outcome === 'BLOCKED_BUDGET' ? 'BLOCKED' : attackResult.outcome === 'NOT_AN_OVERSPEND' ? 'ALLOWED (within budget)' : attackResult.outcome}
                </div>
                <div className="mt-2 text-sm">
                  Enforcement: <span className="text-pp-amber">{attackResult.enforcement}</span> · Agent control: <span className="text-pp-red">{attackResult.agentControl}</span>
                </div>
                {attackResult.reason && <div className="mt-1 text-xs text-pp-mut">Reason: {attackResult.reason}</div>}
                <div className="mt-2 text-sm">Charged: {money(attackResult.chargedDollars)}</div>
              </div>
            )}
          </>
        )}

        {tab === 'verify' && (
          <div className="grid lg:grid-cols-2 gap-4">
            <div className="panel p-5">
              <div className="label mb-3">Delivered Artifacts</div>
              {deliveries.length === 0 && <div className="text-sm text-pp-mut">No deliveries yet. Buy a service first.</div>}
              <div className="space-y-3">
                {deliveries.map((d) => (
                  <div key={d.id} className="border border-pp-line rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-sm">{d.service ?? 'Custom'}</div>
                      <Badge s={d.verificationStatus} />
                    </div>
                    <div className="font-mono text-[11px] text-pp-mut mt-1 break-all">{d.contentHash}</div>
                    <div className="flex gap-2 mt-2">
                      <button className="btn-ghost" onClick={() => verify(d.id)} disabled={busy}>Verify Again</button>
                      <button className="btn-danger" onClick={() => tamper(d.id)} disabled={busy}>Tamper</button>
                      <button className="btn-ghost" onClick={() => viewReceipt(d.paymentId)} disabled={busy}>Receipt</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="panel p-5">
              <div className="label mb-3">Verified Payment Receipt</div>
              {!receipt && <div className="text-sm text-pp-mut">Select a receipt to inspect the combined proof.</div>}
              {receipt && (
                <div className="space-y-4 text-sm">
                  <div className="flex items-center justify-between">
                    <div className="font-bold">{receipt.service ?? 'Custom spend'}</div>
                    <Badge s={receipt.finalStatus} />
                  </div>
                  <Block title="Authorization (budget cap)">
                    <Row k="Budget" v={money(receipt.authorization.budgetDollars)} />
                    <Row k="Spent before" v={money(receipt.authorization.spentBeforeDollars)} />
                    <Row k="Requested" v={money(receipt.authorization.requestedDollars)} />
                    <Row k="Remaining before" v={money(receipt.authorization.remainingBeforeDollars)} />
                    <Row k="Allowed" v={String(receipt.authorization.allowed)} />
                  </Block>
                  <Block title="Payment">
                    <Row k="Status" v={receipt.payment.status} />
                    <Row k="Request" v={receipt.requestId} />
                    <Row k="Idempotency" v={receipt.requestId.replace('req_', 'idem_')} />
                  </Block>
                  <Block title="Delivery">
                    <Row k="Received" v={String(receipt.delivery.received)} />
                    <div className="font-mono text-[11px] text-pp-mut break-all mt-1">{receipt.delivery.artifactHash}</div>
                  </Block>
                  {receipt.verification && (
                    <Block title="VERA — Executable Verification">
                      <Row k="Verifier" v={receipt.verification.verifier} />
                      <Row k="Mode" v={receipt.verification.mode} />
                      <div className="mt-1"><span className="text-pp-mut">Claim: </span>{receipt.verification.claim}</div>
                      <div className="mt-1"><span className="text-pp-mut">Observed: </span>{receipt.verification.observedResult}</div>
                      <div className="mt-1">Verdict: <Badge s={receipt.verification.verdict} /></div>
                    </Block>
                  )}
                  <Block title="Integrity">
                    <Row k="Algorithm" v={receipt.integrity.hashAlgorithm} />
                    <Row k="Hash valid" v={String(receipt.integrity.hashValid)} />
                    <div className="font-mono text-[11px] text-pp-mut break-all mt-1">committed: {receipt.integrity.contentHash}</div>
                    <div className="font-mono text-[11px] text-pp-mut break-all">recomputed: {receipt.integrity.recomputedHash}</div>
                  </Block>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'stream' && (
          <div className="panel p-5 overflow-x-auto">
            <div className="label mb-3">Transaction Stream</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-pp-mut text-left text-[11px] uppercase">
                  <th className="py-2">#</th>
                  <th className="py-2">Time</th>
                  <th className="py-2">Service</th>
                  <th className="py-2">Provider</th>
                  <th className="py-2 text-right">Amount</th>
                  <th className="py-2">Status</th>
                  <th className="py-2">Verification</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.id} className="border-t border-pp-line">
                    <td className="py-2 font-mono text-pp-mut">{t.id}</td>
                    <td className="py-2 font-mono text-[11px] text-pp-mut">{new Date(t.createdAt).toLocaleTimeString()}</td>
                    <td className="py-2">{t.service}</td>
                    <td className="py-2 text-pp-mut">{t.provider ?? '—'}</td>
                    <td className="py-2 text-right font-mono">{money(t.amountDollars)}</td>
                    <td className="py-2"><Badge s={t.status} /></td>
                    <td className="py-2">{t.verification ? <Badge s={t.verification} /> : <span className="text-pp-mut text-xs">—</span>}</td>
                    <td className="py-2 text-right">
                      <button className="btn-ghost !px-2 !py-1" onClick={() => viewReceipt(t.id)}>Receipt</button>
                    </td>
                  </tr>
                ))}
                {txns.length === 0 && (
                  <tr><td colSpan={8} className="py-6 text-center text-pp-mut">No transactions yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'budget' && (
          <div className="space-y-4">
            {/* top row: budget gauge + spend-by-service chart */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="panel p-5">
                <div className="label mb-4">Budget Utilization</div>
                <BudgetDonut
                  spent={policy?.spentDollars ?? 0}
                  cap={policy?.maxBudgetDollars ?? 0}
                />
              </div>
              <div className="panel p-5">
                <div className="label mb-4">Spend by Service</div>
                <SpendBars txns={txns} />
              </div>
            </div>

            {/* spreadsheet ledger */}
            <div className="panel p-5 overflow-x-auto">
              <div className="flex items-center justify-between mb-3">
                <div className="label">Agent Spending Ledger</div>
                <div className="flex items-center gap-3">
                  <div className="text-[11px] text-pp-mut hidden sm:block">Auto-generated by the agent for every charge · CSV-style row per payment</div>
                  <button
                    className="px-3 py-1.5 rounded-full text-[12px] font-medium border border-pp-line hover:bg-pp-bg active:scale-[0.97] transition"
                    onClick={() => exportBudgetXlsx(policy, txns)}
                  >
                    ↓ Download Spreadsheet (.xlsx)
                  </button>
                </div>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-pp-mut text-left text-[11px] uppercase">
                    <th className="py-2">#</th>
                    <th className="py-2">Date</th>
                    <th className="py-2">Item</th>
                    <th className="py-2">Category</th>
                    <th className="py-2">Note</th>
                    <th className="py-2 text-right">Debit</th>
                    <th className="py-2 text-right">Running Balance</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const cap = policy?.maxBudgetDollars ?? 0;
                    // Oldest-first so the running balance accumulates like a real ledger
                    const rows = [...txns].reverse();
                    let running = cap;
                    const out: React.ReactNode[] = [];
                    for (const t of rows) {
                      const debit = ['PAID', 'DELIVERED', 'VERIFIED'].includes(t.status) ? t.amountDollars : 0;
                      const before = running;
                      running -= debit;
                      out.push(
                        <tr key={t.id} className="border-t border-pp-line hover:bg-pp-bg/60 transition-colors">
                          <td className="py-2 font-mono text-pp-mut">{t.id}</td>
                          <td className="py-2 font-mono text-[11px] text-pp-mut">{new Date(t.createdAt).toLocaleTimeString()}</td>
                          <td className="py-2">{t.service}</td>
                          <td className="py-2"><Badge s={t.provider ?? 'AGENT'} /></td>
                          <td className="py-2 text-[12px] text-pp-mut max-w-[220px] truncate">{t.requestId}</td>
                          <td className="py-2 text-right font-mono">{debit > 0 ? `-$${debit.toFixed(2)}` : '—'}</td>
                          <td className="py-2 text-right font-mono font-medium">{money(running)}</td>
                          <td className="py-2">
                            {t.status === 'REJECTED_BUDGET' ? <Badge s="OVER_CAP" /> : t.verification === 'FAILED' ? <Badge s="REFUNDED" /> : <Badge s={t.status} />}
                          </td>
                        </tr>,
                      );
                    }
                    return out;
                  })()}
                  {txns.length === 0 && (
                    <tr><td colSpan={8} className="py-6 text-center text-pp-mut">No spending yet — the agent logs every charge here.</td></tr>
                  )}
                  {txns.length > 0 && (
                    <tr className="border-t-2 border-pp-ink/30 font-semibold">
                      <td className="py-2.5" colSpan={5}>TOTAL DEBITED</td>
                      <td className="py-2.5 text-right font-mono">-${(policy?.spentDollars ?? 0).toFixed(2)}</td>
                      <td className="py-2.5 text-right font-mono text-pp-green">{money(policy?.remainingDollars ?? 0)}</td>
                      <td className="py-2.5" />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'audit' && (
          <div className="panel p-5">
            <div className="label mb-3">Audit Trail</div>
            <div className="space-y-2">
              {events.map((e) => (
                <div key={e.id} className="flex gap-3 text-sm border-b border-pp-line/60 pb-2">
                  <div className="font-mono text-[11px] text-pp-mut w-20 shrink-0">{new Date(e.timestamp).toLocaleTimeString()}</div>
                  <div className="w-48 shrink-0 font-mono text-[11px] text-pp-violet">{e.type}</div>
                  <div className="flex-1">{e.description}</div>
                </div>
              ))}
              {events.length === 0 && <div className="text-sm text-pp-mut">No audit events.</div>}
            </div>
          </div>
        )}

        {tab === 'demo' && (
          <div className="grid lg:grid-cols-2 gap-4">
            <div className="space-y-4">
              <div className="panel p-5">
                <div className="label mb-3">Guided Demo</div>
                <div className="grid grid-cols-2 gap-2">
                  <button className="btn-primary" onClick={() => services[0] && buyWithSheet(services[0])} disabled={busy || !services[0]}>1 · Buy Service ($2)</button>
                  <button className="btn-ghost" onClick={demoRetry} disabled={busy}>2 · Retry Same Request</button>
                  <button className="btn-danger" onClick={attack} disabled={busy}>3 · Attempt Overspend</button>
                  <button className="btn-violet" onClick={() => deliveries[0] && verify(deliveries[0].id)} disabled={busy || deliveries.length === 0}>4 · Verify Delivery</button>
                  <button className="btn-danger" onClick={() => deliveries[0] && tamper(deliveries[0].id)} disabled={busy || deliveries.length === 0}>5 · Tamper Artifact</button>
                  <button className="btn-ghost" onClick={retryLast} disabled={busy || !lastRetry}>Retry Last Failure</button>
                </div>
                <p className="text-xs text-pp-mut mt-3">Every button calls the real backend. Watch the live console and the audit trail.</p>
              </div>

              <div className="panel p-5">
                <div className="flex items-center justify-between">
                  <div className="label">Budget</div>
                  <div className="font-mono text-sm text-pp-green">{money(policy?.remainingDollars)} left of {money(policy?.maxBudgetDollars)}</div>
                </div>
                <div className="h-3 rounded-full bg-pp-line overflow-hidden mt-2">
                  <motion.div
                    className={`h-full rounded-full ${util >= 100 ? 'bg-pp-red' : util >= 60 ? 'bg-pp-amber' : 'bg-pp-green'}`}
                    animate={{ width: `${Math.min(util, 100)}%` }}
                    transition={{ type: 'spring', stiffness: 120, damping: 20 }}
                  />
                </div>
              </div>
            </div>

            <div className="panel p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="label">Live Event Console</div>
                <span className="chip bg-pp-bg text-pp-mut">{busy ? 'RUNNING' : 'IDLE'}</span>
              </div>
              <div className="font-mono text-[12px] space-y-1 max-h-[520px] overflow-y-auto">
                <AnimatePresence initial={false}>
                {log.map((l, i) => (
                  <motion.div
                    key={`${l.t}-${i}`}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="flex gap-2"
                  >
                    <span className="text-pp-mut shrink-0">{l.t}</span>
                    <span className={`shrink-0 ${l.kind.includes('BLOCK') || l.kind.includes('FAIL') || l.kind === 'ERROR' ? 'text-pp-red' : l.kind.includes('VERIFIED') || l.kind.includes('NO_SECOND') ? 'text-pp-green' : 'text-pp-amber'}`}>[{l.kind}]</span>
                    <span>{l.text}</span>
                  </motion.div>
                ))}
                </AnimatePresence>
                {log.length === 0 && <div className="text-pp-mut">Waiting for actions…</div>}
              </div>
            </div>
          </div>
        )}
        </motion.div>
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {sheet && (
          <ApplePaySheet
            sheet={sheet}
            policy={policy ? { remainingDollars: policy.remainingDollars, maxBudgetDollars: policy.maxBudgetDollars } : null}
            onClose={() => setSheet(null)}
            onConfirm={confirmSheetBuy}
          />
        )}
      </AnimatePresence>

      <footer className="max-w-7xl mx-auto px-5 pb-10 pt-2 text-[11px] text-pp-mut">
        SpendOath protects your money and proves the work. · Local deterministic demo · x402-compatible HTTP 402 flow
      </footer>
    </div>
  );
}

function BudgetDonut({ spent, cap }: { spent: number; cap: number }) {
  const pct = cap > 0 ? Math.min(1, spent / cap) : 0;
  const R = 52;
  const C = 2 * Math.PI * R;
  return (
    <div className="flex items-center gap-5">
      <svg width="130" height="130" viewBox="0 0 130 130" className="shrink-0 -rotate-90">
        <circle cx="65" cy="65" r={R} fill="none" stroke="var(--pp-line)" strokeWidth="12" />
        <motion.circle
          cx="65" cy="65" r={R} fill="none" stroke="var(--pp-amber)" strokeWidth="12" strokeLinecap="round"
          initial={{ strokeDashoffset: C }}
          animate={{ strokeDashoffset: C * (1 - pct) }}
          transition={{ type: 'spring', stiffness: 60, damping: 20 }}
          style={{ strokeDasharray: C }}
        />
      </svg>
      <div>
        <div className="text-3xl font-bold tracking-[-0.02em]">{Math.round(pct * 100)}<span className="text-base font-medium text-pp-mut">%</span></div>
        <div className="text-[12px] text-pp-mut mt-1">of {money(cap)} budget used</div>
        <div className="text-[12px] mt-2"><span className="text-pp-amber font-medium">{money(spent)}</span> spent · <span className="text-pp-green font-medium">{money(Math.max(0, cap - spent))}</span> left</div>
      </div>
    </div>
  );
}

function SpendBars({ txns }: { txns: Txn[] }) {
  const byService = new Map<string, number>();
  for (const t of txns) {
    if (!['PAID', 'DELIVERED', 'VERIFIED'].includes(t.status)) continue;
    byService.set(t.service, (byService.get(t.service) ?? 0) + t.amountDollars);
  }
  const rows = [...byService.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map(([, v]) => v));
  return (
    <div className="space-y-3">
      {rows.length === 0 && <div className="text-sm text-pp-mut py-4">No charges yet.</div>}
      {rows.map(([svc, amt], i) => (
        <div key={svc}>
          <div className="flex justify-between text-[12px] mb-1">
            <span className="text-pp-ink font-medium">{svc}</span>
            <span className="font-mono text-pp-mut">{money(amt)}</span>
          </div>
          <div className="h-2.5 rounded-full bg-pp-line/60 overflow-hidden">
            <motion.div
              className="h-full rounded-full"
              style={{ background: 'var(--pp-blue, #0066cc)' }}
              initial={{ width: 0 }}
              animate={{ width: `${(amt / max) * 100}%` }}
              transition={{ delay: i * 0.08, type: 'spring', stiffness: 80, damping: 20 }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {  return (
    <div className="panel p-4">
      <div className="label">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${accent}`}>{value}</div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-[11px] text-pp-mut">{label}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-pp-mut">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-pp-line rounded-lg p-3">
      <div className="label mb-2">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

// ---------- Apple Pay-style sheet ----------

function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const [display, setDisplay] = useState(value);
  useEffect(() => {
    const c = animate(display, value, { duration: 0.6, ease: [0.32, 0.72, 0, 1], onUpdate: (v) => setDisplay(v) });
    return () => c.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return <>{format(display)}</>;
}

function ApplePaySheet({
  sheet,
  policy,
  onClose,
  onConfirm,
}: {
  sheet: NonNullable<Parameters<typeof SheetBody>[0]['sheet']>;
  policy: { remainingDollars: number; maxBudgetDollars: number } | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={sheet.phase === 'processing' ? undefined : onClose} />
      <motion.div
        className="relative w-full sm:max-w-sm sheet-surface-bg rounded-t-[18px] sm:rounded-[18px] shadow-[0_10px_40px_rgba(0,0,0,0.18)] overflow-hidden"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%', transition: { duration: 0.25, ease: [0.32, 0, 1, 1] } }}
        transition={{ type: 'spring', stiffness: 380, damping: 36 }}
      >
        <SheetBody sheet={sheet} policy={policy} onClose={onClose} onConfirm={onConfirm} />
      </motion.div>
    </motion.div>
  );
}

function SheetBody({
  sheet,
  policy,
  onClose,
  onConfirm,
}: {
  sheet:
    | { phase: 'confirm'; service: Service }
    | { phase: 'processing'; service: Service; promise: Promise<any> }
    | { phase: 'done'; service: Service; ok: boolean; charged: number; verdict: string | null };
  policy: { remainingDollars: number; maxBudgetDollars: number } | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const s = sheet.service;
  return (
    <div className="p-5">
      {/* header */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-[12px] tracking-[-0.01em] text-pp-mut font-medium">SpendOath · Agent Payment</span>
        {sheet.phase !== 'processing' && (
          <button onClick={onClose} className="text-pp-mut hover:text-pp-ink text-lg leading-none px-2" aria-label="Close">×</button>
        )}
        {sheet.phase === 'processing' && <span className="chip bg-pp-blue/10 text-pp-blue">ENFORCED</span>}
      </div>

      {/* merchant row */}
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-[11px] bg-pp-blue/10 flex items-center justify-center font-semibold text-pp-blue">
          {s.name.slice(0, 1)}
        </div>
        <div className="flex-1">
          <div className="font-semibold text-[15px]">{s.name}</div>
          <div className="text-[12px] text-pp-mut">{s.providerName}</div>
        </div>
        <div className="text-[22px] font-semibold tracking-[-0.02em]"><CountUp value={s.priceDollars} format={money} /></div>
      </div>

      {/* budget check line — the enforcement message */}
      <div className="rounded-[11px] bg-pp-bg p-3 text-[12px] space-y-1.5 mb-4">
        <div className="flex justify-between">
          <span className="text-pp-mut">Budget cap</span>
          <span className="text-pp-ink">{money(policy?.maxBudgetDollars)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-pp-mut">Server check</span>
          <span className={(policy?.remainingDollars ?? 0) >= s.priceDollars ? 'text-pp-green font-medium' : 'text-pp-red font-medium'}>
            {(policy?.remainingDollars ?? 0) >= s.priceDollars ? '✓ within cap' : '✗ exceeds cap'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-pp-mut">After charge</span>
          <span className="text-pp-ink">{money(Math.max(0, (policy?.remainingDollars ?? 0) - s.priceDollars))}</span>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {sheet.phase === 'confirm' && (
          <motion.button
            key="confirm"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            onClick={onConfirm}
            className="w-full py-3.5 rounded-[12px] font-semibold text-[15px] btn-apay-bg hover:opacity-85 active:scale-[0.98] transition-transform flex items-center justify-center gap-2"
          >
            <span className="font-semibold tracking-[-0.01em]">Pay</span>
            <span className="opacity-70 font-normal">{money(s.priceDollars)}</span>
          </motion.button>
        )}

        {sheet.phase === 'processing' && (
          <motion.div key="processing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="py-3">
            <div className="flex items-center gap-3 justify-center mb-3">
              <div className="flex gap-1.5">
                {[0, 1, 2].map((i) => (
                  <motion.span
                    key={i}
                    className="w-2 h-2 rounded-full bg-pp-green"
                    animate={{ opacity: [0.25, 1, 0.25] }}
                    transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18 }}
                  />
                ))}
              </div>
              <span className="text-sm text-pp-mut">Enforcement engine running — 402 · pay · deliver · verify</span>
            </div>
            <div className="h-1.5 rounded-full bg-pp-line overflow-hidden">
              <motion.div
                className="h-full bg-pp-green rounded-full"
                initial={{ width: '0%' }}
                animate={{ width: '88%' }}
                transition={{ duration: 2.2, ease: 'easeOut' }}
              />
            </div>
            <div className="mt-3 text-[11px] text-pp-mut text-center">The agent cannot override this. Server decides.</div>
          </motion.div>
        )}

        {sheet.phase === 'done' && (
          <motion.div key="done" initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-2">
            <div className="flex justify-center mb-3">
              <motion.div
                className={`w-16 h-16 rounded-full flex items-center justify-center text-3xl font-bold ${sheet.ok ? 'bg-pp-green/15 border-2 border-pp-green' : 'bg-pp-red/15 border-2 border-pp-red'}`}
                initial={{ scale: 0.5 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 500, damping: 18 }}
              >
                <motion.span
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ delay: 0.12, type: 'spring', stiffness: 500, damping: 20 }}
                  className={sheet.ok ? 'text-pp-green' : 'text-pp-red'}
                >
                  {sheet.ok ? '✓' : '✕'}
                </motion.span>
              </motion.div>
            </div>
            <div className={`font-bold text-lg ${sheet.ok ? 'text-pp-green' : 'text-pp-red'}`}>
              {sheet.ok ? 'Verified & Settled' : 'Blocked'}
            </div>
            <div className="text-sm text-pp-mut mt-1 font-mono">
              {sheet.ok ? `${money(sheet.charged)} charged · ${sheet.verdict}` : sheet.verdict}
            </div>
              <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.3 }}
              onClick={onClose}
              className="mt-4 w-full py-3 rounded-[12px] font-semibold bg-pp-bg text-pp-blue hover:brightness-[0.98]"
            >
              Done
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}