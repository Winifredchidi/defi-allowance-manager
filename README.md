# Smart Allowance Manager (HackMoney)

Built during ETHGlobal HackMoney 2026

A simple security-focused web app that helps users check, approve, revoke, and flag risky ERC-20 allowances for common DeFi spenders.

## Problem
Many DeFi users unknowingly grant unlimited token approvals. If a spender contract is compromised, funds can be drained.

## Solution
Smart Allowance Manager makes approvals visible and reversible.

## Features
- Connect wallet
- Choose spender (Uniswap, Permit2, 1inch, or custom)
- Check ERC-20 allowances
- Approve limited amounts
- Approve unlimited amounts
- Revoke allowances
- Risk labels (LOW / MEDIUM / HIGH)
- Add custom tokens

## Tech Stack
- Next.js  
- ethers v6  
- MetaMask  
- JavaScript / TypeScript  
- Vercel (deployment)

## How it works
- Reads allowances using `allowance(owner, spender)`
- Writes approvals using `approve(spender, amount)`
- Built with ethers v6 + MetaMask

## Demo flow
1. Connect wallet  
2. Select spender  
3. Refresh allowances  
4. Approve token  
5. Revoke approval  

## Run locally
```bash
npm install
npm run dev
