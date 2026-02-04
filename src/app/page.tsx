"use client"

import { useEffect, useMemo, useState } from "react"
import { ethers } from "ethers"

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]

const MAINNET_CHAIN_ID = 1

type RiskLevel = "LOW" | "MEDIUM" | "HIGH"

type AllowanceInfo = {
  raw: bigint
  decimals: number
  formatted: string
  isUnlimitedExact: boolean
  isUnlimitedLike: boolean
  risk: RiskLevel
}

type TokenItem = {
  id: string
  key: string
  name: string
  address: string
  isCustom: boolean
}

type SpenderPreset = {
  id: string
  label: string
  address: string
  note?: string
}

const DEFAULT_TOKENS: TokenItem[] = [
  { id: "usdt", key: "USDT", name: "Tether USD", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", isCustom: false },
  { id: "usdc", key: "USDC", name: "USD Coin", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", isCustom: false },
  { id: "dai", key: "DAI", name: "Dai Stablecoin", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", isCustom: false },
  { id: "weth", key: "WETH", name: "Wrapped Ether", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", isCustom: false },
]

/**
 * Presets (mainnet addresses):
 * - Uniswap V2 Router: 0x7a25...
 * - Uniswap Permit2:   0x0000...22D473030F116dDEE9F6B43aC78BA3
 * - 1inch Router v5:   0x1111111254EEB25477B68fb85Ed929f73A960582
 *
 * (You can still use “Custom” if you want a different spender.)
 */
const SPENDER_PRESETS: SpenderPreset[] = [
  {
    id: "uniswap-v2-router",
    label: "Uniswap V2 Router",
    address: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    note: "Classic router approvals",
  },
  {
    id: "uniswap-permit2",
    label: "Uniswap Permit2",
    address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    note: "Modern allowance manager used by many apps",
  },
  {
    id: "1inch-router-v5",
    label: "1inch Router v5",
    address: "0x1111111254EEB25477B68fb85Ed929f73A960582",
    note: "Common DEX aggregator spender",
  },
]

const LS_TOKENS_KEY = "sam_custom_tokens_v3"
const LS_SPENDER_KEY = "sam_spender_v1"

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function riskBadgeClasses(risk: RiskLevel) {
  if (risk === "HIGH") return "bg-red-100 text-red-800 border-red-200"
  if (risk === "MEDIUM") return "bg-yellow-100 text-yellow-800 border-yellow-200"
  return "bg-green-100 text-green-800 border-green-200"
}

function riskRank(risk: RiskLevel) {
  if (risk === "HIGH") return 3
  if (risk === "MEDIUM") return 2
  return 1
}

function isUnlimitedLike(raw: bigint, decimals: number) {
  if (raw === ethers.MaxUint256) return { exact: true, like: true }

  const nearMaxThreshold = (ethers.MaxUint256 / 100n) * 99n
  if (raw >= nearMaxThreshold) return { exact: false, like: true }

  try {
    const hugeTokenThreshold = ethers.parseUnits("1000000000", decimals) // 1B tokens heuristic
    if (raw >= hugeTokenThreshold) return { exact: false, like: true }
  } catch {}

  return { exact: false, like: false }
}

function computeRisk(raw: bigint, decimals: number) {
  const unlim = isUnlimitedLike(raw, decimals)
  if (unlim.like) return { risk: "HIGH" as RiskLevel, ...unlim }

  const mediumThreshold = ethers.parseUnits("1000", decimals)
  const highThreshold = ethers.parseUnits("10000", decimals)

  if (raw >= highThreshold) return { risk: "HIGH" as RiskLevel, ...unlim }
  if (raw >= mediumThreshold) return { risk: "MEDIUM" as RiskLevel, ...unlim }
  return { risk: "LOW" as RiskLevel, ...unlim }
}

function safeUpperLabel(s: string) {
  return s.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 12) || "TOKEN"
}

export default function Home() {
  const [address, setAddress] = useState<string | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [sortByRisk, setSortByRisk] = useState(true)

  const [tokens, setTokens] = useState<TokenItem[]>(DEFAULT_TOKENS)
  const [allowances, setAllowances] = useState<Record<string, AllowanceInfo | null>>({})
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  // Token add form
  const [newTokenAddress, setNewTokenAddress] = useState("")
  const [newTokenLabel, setNewTokenLabel] = useState("")

  // Spender selection
  const presets = useMemo(() => SPENDER_PRESETS, [])
  const [spenderMode, setSpenderMode] = useState<"preset" | "custom">("preset")
  const [selectedPresetId, setSelectedPresetId] = useState<string>(presets[0]?.id ?? "uniswap-v2-router")
  const [customSpenderInput, setCustomSpenderInput] = useState("")
  const [customSpenderApplied, setCustomSpenderApplied] = useState<string | null>(null)

  function getEthereum() {
    if (typeof window === "undefined") return null
    return (window as any).ethereum ?? null
  }

  function getActiveSpender(): string {
    if (spenderMode === "preset") {
      const p = presets.find((x) => x.id === selectedPresetId) ?? presets[0]
      return p?.address ?? presets[0].address
    }
    // custom
    return customSpenderApplied ?? ""
  }

  const activeSpender = getActiveSpender()

  async function syncNetwork() {
    try {
      const ethereum = getEthereum()
      if (!ethereum) return
      const provider = new ethers.BrowserProvider(ethereum)
      const net = await provider.getNetwork()
      setChainId(Number(net.chainId))
    } catch (e) {
      console.error("syncNetwork failed:", e)
    }
  }

  // Load custom tokens + spender state
  useEffect(() => {
    // tokens
    try {
      const raw = localStorage.getItem(LS_TOKENS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as TokenItem[]
        if (Array.isArray(parsed)) {
          const existing = new Set(DEFAULT_TOKENS.map((t) => t.address.toLowerCase()))
          const cleaned = parsed
            .filter((t) => t?.address && ethers.isAddress(t.address))
            .filter((t) => !existing.has(t.address.toLowerCase()))
            .map((t) => ({
              id: t.address.toLowerCase(),
              key: safeUpperLabel(t.key || "TOKEN"),
              name: t.name || "Custom Token",
              address: ethers.getAddress(t.address),
              isCustom: true,
            }))
          if (cleaned.length > 0) setTokens([...DEFAULT_TOKENS, ...cleaned])
        }
      }
    } catch (e) {
      console.error("Failed to load tokens:", e)
    }

    // spender
    try {
      const raw = localStorage.getItem(LS_SPENDER_KEY)
      if (raw) {
        const saved = JSON.parse(raw) as {
          mode?: "preset" | "custom"
          presetId?: string
          customApplied?: string | null
          customInput?: string
        }

        if (saved?.mode === "custom") {
          setSpenderMode("custom")
          setCustomSpenderInput(saved.customInput ?? "")
          setCustomSpenderApplied(saved.customApplied ?? null)
        } else {
          setSpenderMode("preset")
          if (saved?.presetId && presets.some((p) => p.id === saved.presetId)) {
            setSelectedPresetId(saved.presetId)
          }
        }
      }
    } catch (e) {
      console.error("Failed to load spender:", e)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Save custom tokens
  useEffect(() => {
    try {
      const custom = tokens.filter((t) => t.isCustom)
      localStorage.setItem(LS_TOKENS_KEY, JSON.stringify(custom))
    } catch (e) {
      console.error("Failed to save tokens:", e)
    }
  }, [tokens])

  // Save spender
  useEffect(() => {
    try {
      localStorage.setItem(
        LS_SPENDER_KEY,
        JSON.stringify({
          mode: spenderMode,
          presetId: selectedPresetId,
          customApplied: customSpenderApplied,
          customInput: customSpenderInput,
        })
      )
    } catch (e) {
      console.error("Failed to save spender:", e)
    }
  }, [spenderMode, selectedPresetId, customSpenderApplied, customSpenderInput])

  // Listen for MetaMask changes
  useEffect(() => {
    const ethereum = getEthereum()
    if (!ethereum) return

    syncNetwork()

    const onChainChanged = () => syncNetwork()
    const onAccountsChanged = (accs: string[]) => setAddress(accs?.[0] ?? null)

    ethereum.on?.("chainChanged", onChainChanged)
    ethereum.on?.("accountsChanged", onAccountsChanged)

    return () => {
      ethereum.removeListener?.("chainChanged", onChainChanged)
      ethereum.removeListener?.("accountsChanged", onAccountsChanged)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function connectWallet() {
    setMessage(null)
    try {
      const ethereum = getEthereum()
      if (!ethereum) {
        alert("MetaMask not found. Open this in the browser where MetaMask is installed.")
        return
      }
      const accounts = await ethereum.request({ method: "eth_requestAccounts" })
      setAddress(accounts?.[0] ?? null)
      await syncNetwork()
    } catch (e) {
      console.error("connectWallet failed:", e)
      alert("Failed to connect wallet. Check console.")
    }
  }

  async function getTokenContract(tokenAddress: string, useSigner: boolean) {
    const ethereum = getEthereum()
    if (!ethereum) throw new Error("MetaMask not found")
    const provider = new ethers.BrowserProvider(ethereum)
    if (useSigner) {
      const signer = await provider.getSigner()
      return new ethers.Contract(tokenAddress, ERC20_ABI, signer)
    }
    return new ethers.Contract(tokenAddress, ERC20_ABI, provider)
  }

  async function checkAllowance(token: TokenItem) {
    if (!address) return
    if (!activeSpender || !ethers.isAddress(activeSpender)) {
      alert("Pick a valid spender first.")
      return
    }

    setMessage(null)
    setLoading(`check-${token.address}`)

    try {
      const contract = await getTokenContract(token.address, false)
      const decimals = (await contract.decimals()) as number
      const raw = (await contract.allowance(address, activeSpender)) as bigint
      const formatted = ethers.formatUnits(raw, decimals)
      const riskInfo = computeRisk(raw, decimals)

      setAllowances((p) => ({
        ...p,
        [token.address.toLowerCase()]: {
          raw,
          decimals,
          formatted,
          isUnlimitedExact: riskInfo.exact,
          isUnlimitedLike: riskInfo.like,
          risk: riskInfo.risk,
        },
      }))
    } catch (e) {
      console.error(`checkAllowance failed (${token.key}):`, e)
      alert("Failed to read allowance. Check console.")
    } finally {
      setLoading(null)
    }
  }

  async function refreshAll() {
    if (!address) return
    if (!activeSpender || !ethers.isAddress(activeSpender)) {
      alert("Pick a valid spender first.")
      return
    }

    setMessage(null)
    setLoading("refresh-all")
    try {
      for (const t of tokens) {
        // eslint-disable-next-line no-await-in-loop
        await checkAllowance(t)
      }
      setMessage("All allowances refreshed ✅")
    } finally {
      setLoading(null)
    }
  }

  async function approveToken(token: TokenItem) {
    if (!address) return
    if (!activeSpender || !ethers.isAddress(activeSpender)) {
      alert("Pick a valid spender first.")
      return
    }

    setMessage(null)
    setLoading(`approve-${token.address}`)

    try {
      const contract = await getTokenContract(token.address, true)
      const decimals = (await contract.decimals()) as number
      const input = (amounts[token.address.toLowerCase()] ?? "0").trim()
      const parsed = ethers.parseUnits(input === "" ? "0" : input, decimals)

      const tx = await contract.approve(activeSpender, parsed)
      setMessage(`${token.key}: Transaction sent. Waiting for confirmation…`)
      await tx.wait()

      setMessage(`${token.key}: Approved ✅ Refreshing allowance…`)
      await checkAllowance(token)
      setMessage(`${token.key}: Done ✅`)
    } catch (e: any) {
      if (e?.code === 4001 || e?.code === "ACTION_REJECTED") setMessage("You cancelled the transaction.")
      else {
        console.error(`approveToken failed (${token.key}):`, e)
        alert("Approve failed. Check console.")
      }
    } finally {
      setLoading(null)
    }
  }

  async function approveUnlimited(token: TokenItem) {
    if (!address) return
    if (!activeSpender || !ethers.isAddress(activeSpender)) {
      alert("Pick a valid spender first.")
      return
    }

    setMessage(null)
    setLoading(`unlimited-${token.address}`)

    try {
      const contract = await getTokenContract(token.address, true)
      const tx = await contract.approve(activeSpender, ethers.MaxUint256)
      setMessage(`${token.key}: Unlimited approval sent. Waiting for confirmation…`)
      await tx.wait()

      setMessage(`${token.key}: Unlimited approved ✅ Refreshing allowance…`)
      await checkAllowance(token)
      setMessage(`${token.key}: Done ✅`)
    } catch (e: any) {
      if (e?.code === 4001 || e?.code === "ACTION_REJECTED") setMessage("You cancelled the transaction.")
      else {
        console.error(`approveUnlimited failed (${token.key}):`, e)
        alert("Unlimited approve failed. Check console.")
      }
    } finally {
      setLoading(null)
    }
  }

  async function revokeToken(token: TokenItem) {
    if (!address) return
    if (!activeSpender || !ethers.isAddress(activeSpender)) {
      alert("Pick a valid spender first.")
      return
    }

    setMessage(null)
    setLoading(`revoke-${token.address}`)

    try {
      const contract = await getTokenContract(token.address, true)
      const tx = await contract.approve(activeSpender, 0n)
      setMessage(`${token.key}: Revoke sent. Waiting for confirmation…`)
      await tx.wait()

      setMessage(`${token.key}: Revoked ✅ Refreshing allowance…`)
      await checkAllowance(token)
      setMessage(`${token.key}: Done ✅`)
    } catch (e: any) {
      if (e?.code === 4001 || e?.code === "ACTION_REJECTED") setMessage("You cancelled the transaction.")
      else {
        console.error(`revokeToken failed (${token.key}):`, e)
        alert("Revoke failed. Check console.")
      }
    } finally {
      setLoading(null)
    }
  }

  async function addCustomToken() {
    setMessage(null)

    const addr = newTokenAddress.trim()
    if (!ethers.isAddress(addr)) {
      alert("Please paste a valid ERC20 token address.")
      return
    }

    const checksum = ethers.getAddress(addr)
    const exists = tokens.some((t) => t.address.toLowerCase() === checksum.toLowerCase())
    if (exists) {
      alert("That token is already in your list.")
      return
    }

    setLoading("add-token")

    try {
      const contract = await getTokenContract(checksum, false)
      const decimals = (await contract.decimals()) as number

      let symbol = ""
      let name = ""
      try {
        symbol = ((await contract.symbol()) as string) || ""
      } catch {}
      try {
        name = ((await contract.name()) as string) || ""
      } catch {}

      const key = safeUpperLabel(newTokenLabel || symbol || "TOKEN")
      const displayName = name || "Custom Token"

      const newItem: TokenItem = {
        id: checksum.toLowerCase(),
        key,
        name: `${displayName} (decimals: ${decimals})`,
        address: checksum,
        isCustom: true,
      }

      setTokens((prev) => [...prev, newItem])
      setAmounts((p) => ({ ...p, [checksum.toLowerCase()]: "10" }))

      setNewTokenAddress("")
      setNewTokenLabel("")
      setMessage(`Added ${key} ✅`)
    } catch (e) {
      console.error("Add token failed:", e)
      alert("Could not validate this token as ERC20 (decimals() failed).")
    } finally {
      setLoading(null)
    }
  }

  function removeCustomToken(token: TokenItem) {
    if (!token.isCustom) return
    setTokens((prev) => prev.filter((t) => t.address.toLowerCase() !== token.address.toLowerCase()))
    setMessage(`Removed ${token.key}`)
  }

  function applyCustomSpender() {
    setMessage(null)
    const raw = customSpenderInput.trim()
    if (!ethers.isAddress(raw)) {
      alert("Paste a valid spender address (0x...).")
      return
    }
    const checksum = ethers.getAddress(raw)
    setCustomSpenderApplied(checksum)
    setMessage(`Custom spender applied: ${shortAddr(checksum)} ✅`)
    // Clear allowances display because spender changed (avoid confusion)
    setAllowances({})
  }

  function usePreset(presetId: string) {
    setMessage(null)
    setSpenderMode("preset")
    setSelectedPresetId(presetId)
    setAllowances({})
  }

  const isMainnet = chainId === MAINNET_CHAIN_ID

  const displayTokens = useMemo(() => {
    const enriched = tokens.map((t) => {
      const info = allowances[t.address.toLowerCase()]
      const rank = info ? riskRank(info.risk) : 0
      return { ...t, _rank: rank }
    })

    if (!sortByRisk) return enriched
    return [...enriched].sort((a, b) => {
      if (b._rank !== a._rank) return b._rank - a._rank
      return a.key.localeCompare(b.key)
    })
  }, [tokens, allowances, sortByRisk])

  const activePreset = presets.find((p) => p.id === selectedPresetId) ?? presets[0]
  const spenderLabel =
    spenderMode === "preset"
      ? `${activePreset?.label ?? "Preset"}`
      : customSpenderApplied
        ? "Custom"
        : "Custom (not set)"

  return (
    <main className="min-h-screen bg-zinc-50 font-sans">
      <div className="mx-auto w-full max-w-5xl px-6 py-10">
        <h1 className="text-3xl font-bold text-black">Smart Allowance Manager</h1>
        <p className="mt-2 text-zinc-600">
          Manage token approvals: choose a spender, check allowance, approve, revoke, and flag risky/unlimited approvals.
        </p>

        {/* Connect */}
        <div className="mt-6 rounded-lg bg-white p-5 shadow">
          {!address ? (
            <button onClick={connectWallet} className="rounded bg-black px-6 py-3 text-white hover:opacity-90">
              Connect Wallet
            </button>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm">
                <div className="text-zinc-500">Connected</div>
                <div className="font-mono">{shortAddr(address)}</div>
              </div>
              <div className="text-sm">
                <div className="text-zinc-500">Network (chainId)</div>
                <div className="font-mono">{chainId ?? "—"}</div>
              </div>
              <div className="text-sm">
                <div className="text-zinc-500">Active spender</div>
                <div className="font-mono">
                  {spenderMode === "preset" ? shortAddr(activePreset.address) : activeSpender ? shortAddr(activeSpender) : "—"}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setSortByRisk((v) => !v)}
                  className="rounded border border-zinc-200 bg-white px-4 py-2 text-sm hover:bg-zinc-50"
                >
                  Sort: {sortByRisk ? "Risk (HIGH→LOW)" : "Default"}
                </button>

                <button
                  onClick={refreshAll}
                  disabled={loading !== null}
                  className="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading === "refresh-all" ? "Refreshing…" : "Refresh all"}
                </button>
              </div>
            </div>
          )}
        </div>

        {!isMainnet && address && (
          <div className="mt-4 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-900">
            You’re not on Ethereum Mainnet. Default token addresses + spender presets are mainnet addresses.
          </div>
        )}

        {message && (
          <div className="mt-4 rounded-lg bg-zinc-900 px-4 py-3 text-sm text-white">
            {message}
          </div>
        )}

        {/* Spender picker */}
        <div className="mt-6 rounded-lg bg-white p-5 shadow">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Spender</h2>
              <p className="mt-1 text-sm text-zinc-600">
                Pick who you’re granting permission to spend your tokens.
              </p>
            </div>
            <div className="text-sm text-zinc-600">
              Current: <span className="font-semibold text-zinc-900">{spenderLabel}</span>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {/* Presets */}
            <div className="rounded-lg border border-zinc-200 p-4">
              <div className="flex items-center justify-between">
                <div className="font-semibold">Presets</div>
                <button
                  onClick={() => setSpenderMode("preset")}
                  className={`rounded px-3 py-1 text-xs ${
                    spenderMode === "preset" ? "bg-black text-white" : "border border-zinc-200 bg-white"
                  }`}
                >
                  Use presets
                </button>
              </div>

              <div className="mt-3 space-y-2">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => usePreset(p.id)}
                    className={`w-full rounded border px-3 py-2 text-left text-sm hover:bg-zinc-50 ${
                      spenderMode === "preset" && selectedPresetId === p.id ? "border-black" : "border-zinc-200"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-semibold">{p.label}</div>
                      <div className="font-mono text-xs text-zinc-500">{shortAddr(p.address)}</div>
                    </div>
                    {p.note && <div className="mt-1 text-xs text-zinc-600">{p.note}</div>}
                  </button>
                ))}
              </div>
            </div>

            {/* Custom spender */}
            <div className="rounded-lg border border-zinc-200 p-4">
              <div className="flex items-center justify-between">
                <div className="font-semibold">Custom spender</div>
                <button
                  onClick={() => setSpenderMode("custom")}
                  className={`rounded px-3 py-1 text-xs ${
                    spenderMode === "custom" ? "bg-black text-white" : "border border-zinc-200 bg-white"
                  }`}
                >
                  Use custom
                </button>
              </div>

              <div className="mt-3">
                <input
                  value={customSpenderInput}
                  onChange={(e) => setCustomSpenderInput(e.target.value)}
                  className="w-full rounded border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                  placeholder="Spender address (0x...)"
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    onClick={applyCustomSpender}
                    className="rounded bg-black px-4 py-2 text-sm text-white hover:opacity-90"
                  >
                    Apply custom spender
                  </button>

                  {customSpenderApplied && (
                    <button
                      onClick={() => {
                        setCustomSpenderApplied(null)
                        setAllowances({})
                        setMessage("Custom spender cleared.")
                      }}
                      className="rounded border border-zinc-200 bg-white px-4 py-2 text-sm hover:bg-zinc-50"
                    >
                      Clear
                    </button>
                  )}
                </div>

                <div className="mt-2 text-xs text-zinc-600">
                  Applied:{" "}
                  <span className="font-mono">
                    {customSpenderApplied ? shortAddr(customSpenderApplied) : "—"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-3 text-xs text-zinc-500">
            Changing spender clears the displayed allowances (to avoid mixing results).
          </div>
        </div>

        {/* Add custom token */}
        <div className="mt-6 rounded-lg bg-white p-5 shadow">
          <h2 className="text-lg font-semibold">Add a custom ERC-20 token</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Paste a token contract address. We validate it by calling <span className="font-mono">decimals()</span>.
          </p>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={newTokenAddress}
              onChange={(e) => setNewTokenAddress(e.target.value)}
              className="w-full rounded border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
              placeholder="Token address (0x...)"
            />
            <input
              value={newTokenLabel}
              onChange={(e) => setNewTokenLabel(e.target.value)}
              className="w-full rounded border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400 sm:w-44"
              placeholder="Label (optional)"
            />
            <button
              onClick={addCustomToken}
              disabled={loading !== null}
              className="rounded bg-black px-5 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading === "add-token" ? "Adding…" : "Add token"}
            </button>
          </div>
        </div>

        {/* Dashboard */}
        <div className="mt-8 overflow-hidden rounded-lg bg-white shadow">
          <div className="border-b px-5 py-4">
            <h2 className="text-lg font-semibold">Allowances</h2>
            <p className="text-sm text-zinc-600">
              Spender:{" "}
              <span className="font-mono">
                {spenderMode === "preset"
                  ? `${activePreset.label} (${shortAddr(activePreset.address)})`
                  : activeSpender
                    ? shortAddr(activeSpender)
                    : "—"}
              </span>
            </p>
            <p className="mt-1 text-sm text-zinc-600">
              Risk rules: Unlimited/Unlimited-ish = HIGH. ≥ 10,000 tokens = HIGH. ≥ 1,000 tokens = MEDIUM. Otherwise LOW.
            </p>
          </div>

          <div className="divide-y">
            {displayTokens.map((t) => {
              const info = allowances[t.address.toLowerCase()]
              const amtKey = t.address.toLowerCase()

              const isChecking = loading === `check-${t.address}`
              const isApproving = loading === `approve-${t.address}`
              const isRevoking = loading === `revoke-${t.address}`
              const isUnlimitedApproving = loading === `unlimited-${t.address}`

              return (
                <div
                  key={t.address}
                  className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-base font-semibold">{t.key}</div>

                      {info?.risk && (
                        <span
                          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${riskBadgeClasses(
                            info.risk
                          )}`}
                        >
                          {info.risk}
                          {info.isUnlimitedExact ? " (UNLIMITED)" : info.isUnlimitedLike ? " (UNLIMITED-ish)" : ""}
                        </span>
                      )}

                      {t.isCustom && (
                        <span className="rounded border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs text-zinc-700">
                          Custom
                        </span>
                      )}
                    </div>

                    <div className="text-sm text-zinc-600">{t.name}</div>
                    <div className="mt-1 font-mono text-xs text-zinc-500">{shortAddr(t.address)}</div>

                    {t.isCustom && (
                      <button onClick={() => removeCustomToken(t)} className="mt-2 text-xs text-red-600 hover:underline">
                        Remove token
                      </button>
                    )}
                  </div>

                  <div className="flex flex-col gap-2 sm:items-end">
                    <div className="text-sm">
                      <span className="text-zinc-500">Allowance: </span>
                      <span className="font-mono">{info ? info.formatted : "—"}</span>{" "}
                      <span className="text-zinc-500">{t.key}</span>
                    </div>

                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <button
                        onClick={() => checkAllowance(t)}
                        disabled={!address || loading !== null}
                        className="rounded border border-zinc-200 bg-white px-4 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
                      >
                        {isChecking ? "Checking…" : "Check"}
                      </button>

                      <div className="flex items-center gap-2">
                        <input
                          value={amounts[amtKey] ?? "10"}
                          onChange={(e) => setAmounts((p) => ({ ...p, [amtKey]: e.target.value }))}
                          className="w-28 rounded border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                          placeholder="Amount"
                          inputMode="decimal"
                        />

                        <button
                          onClick={() => approveToken(t)}
                          disabled={!address || loading !== null}
                          className="rounded bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50"
                        >
                          {isApproving ? "Approving…" : "Approve"}
                        </button>

                        <button
                          onClick={() => approveUnlimited(t)}
                          disabled={!address || loading !== null}
                          className="rounded bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700 disabled:opacity-50"
                          title="Approve MaxUint256 (unlimited) — high risk"
                        >
                          {isUnlimitedApproving ? "Processing…" : "Unlimited"}
                        </button>

                        <button
                          onClick={() => revokeToken(t)}
                          disabled={!address || loading !== null}
                          className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          {isRevoking ? "Revoking…" : "Revoke"}
                        </button>
                      </div>
                    </div>

                    <div className="text-xs text-zinc-500">
                      Approve/Revoke are real transactions (gas fees). Unlimited approvals are risky.
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

       
      </div>
    </main>
  )
}

