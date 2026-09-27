/**
 * Authorization Service
 *
 * Manages ERC20 and ERC1155 approvals required for trading on Polymarket.
 *
 * Required approvals for trading:
 * - ERC20 (USDC): Approve USDC spending for CTF Exchange, Neg Risk Exchange, etc.
 * - ERC1155 (Conditional Tokens): Approve operators for conditional token transfers
 *
 * @see https://docs.polymarket.com/
 */

import { ethers } from 'ethers';
import {
  CTF_CONTRACT,
  NEG_RISK_CTF_EXCHANGE,
  NEG_RISK_ADAPTER,
  USDC_CONTRACT,
} from '../clients/ctf-client.js';

// Contract addresses
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const CONDITIONAL_TOKENS = CTF_CONTRACT;

// ABIs
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const ERC1155_ABI = [
  'function setApprovalForAll(address operator, bool approved) external',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
];

// Types
export interface AllowanceInfo {
  contract: string;
  address: string;
  approved: boolean;
  allowance?: string;
}

export interface AllowancesResult {
  wallet: string;
  usdcBalance: string;
  erc20Allowances: AllowanceInfo[];
  erc1155Approvals: AllowanceInfo[];
  tradingReady: boolean;
  issues: string[];
}

export interface ApprovalTxResult {
  contract: string;
  txHash?: string;
  success: boolean;
  error?: string;
}

export interface ApprovalsResult {
  wallet: string;
  erc20Approvals: ApprovalTxResult[];
  erc1155Approvals: ApprovalTxResult[];
  allApproved: boolean;
  summary: string;
}

export interface AuthorizationServiceConfig {
  provider?: ethers.providers.Provider;
}

// Contracts that need ERC20 approval
const ERC20_SPENDERS = [
  { name: 'CTF Exchange', address: CTF_EXCHANGE },
  { name: 'Neg Risk CTF Exchange', address: NEG_RISK_CTF_EXCHANGE },
  { name: 'Neg Risk Adapter', address: NEG_RISK_ADAPTER },
  { name: 'Conditional Tokens', address: CONDITIONAL_TOKENS },
];

// Operators that need ERC1155 approval
const ERC1155_OPERATORS = [
  { name: 'CTF Exchange', address: CTF_EXCHANGE },
  { name: 'Neg Risk CTF Exchange', address: NEG_RISK_CTF_EXCHANGE },
  { name: 'Neg Risk Adapter', address: NEG_RISK_ADAPTER },
];

/**
 * Service for managing trading authorizations on Polymarket
 *
 * @example
 * ```typescript
 * const authService = new AuthorizationService(signer);
 *
 * // Check all allowances
 * const status = await authService.checkAllowances();
 * console.log(`Trading ready: ${status.tradingReady}`);
 * if (!status.tradingReady) {
 *   console.log('Issues:', status.issues);
 * }
 *
 * // Set up all approvals
 * const result = await authService.approveAll();
 * console.log(result.summary);
 * ```
 */
export class AuthorizationService {
  private signer: ethers.Wallet;
  private provider: ethers.providers.Provider;

  constructor(signer: ethers.Wallet, config: AuthorizationServiceConfig = {}) {
    this.signer = signer;
    this.provider = config.provider || signer.provider || new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL || 'https://polygon.drpc.org');
  }

  /**
   * Get the wallet address
   */
  get walletAddress(): string {
    return this.signer.address;
  }

  /**
   * Check all ERC20 and ERC1155 allowances required for trading
   *
   * @returns Status of all allowances and whether trading is ready
   */
  async checkAllowances(): Promise<AllowancesResult> {
    const walletAddress = this.signer.address;

    const usdc = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, this.provider);
    const conditionalTokens = new ethers.Contract(CONDITIONAL_TOKENS, ERC1155_ABI, this.provider);

    const issues: string[] = [];

    // --- Solde USDC ---------------------------------------------------------
    // FAIL-CLOSED : si la lecture on-chain échoue, on ne renvoie JAMAIS un
    // résultat « prêt à trader ». On marque l'issue et on continue pour que
    // l'appelant reçoive toujours un objet exploitable (jamais une exception qui
    // serait avalée en amont et laisserait le bot croire que tout va bien).
    let balanceFormatted = '0.00';
    try {
      const balance = await usdc.balanceOf(walletAddress);
      balanceFormatted = ethers.utils.formatUnits(balance, 6);
    } catch (err) {
      issues.push(`ERC20: lecture du solde USDC impossible — ${this.errMsg(err)}`);
    }

    // --- Allowances ERC20 ---------------------------------------------------
    const erc20Allowances: AllowanceInfo[] = [];
    for (const spender of ERC20_SPENDERS) {
      try {
        const allowance = await usdc.allowance(walletAddress, spender.address);
        const allowanceNum = parseFloat(ethers.utils.formatUnits(allowance, 6));
        const isUnlimited = allowanceNum > 1e12;

        erc20Allowances.push({
          contract: spender.name,
          address: spender.address,
          approved: isUnlimited,
          allowance: isUnlimited ? 'unlimited' : allowanceNum.toFixed(2),
        });
      } catch (err) {
        // Vérification impossible ⇒ NOT approved (jamais « approved par défaut »).
        erc20Allowances.push({
          contract: spender.name,
          address: spender.address,
          approved: false,
          allowance: 'unknown',
        });
        issues.push(`ERC20: vérification ${spender.name} impossible — ${this.errMsg(err)}`);
      }
    }

    // --- Approbations ERC1155 ----------------------------------------------
    const erc1155Approvals: AllowanceInfo[] = [];
    for (const operator of ERC1155_OPERATORS) {
      try {
        const isApproved = await conditionalTokens.isApprovedForAll(walletAddress, operator.address);
        erc1155Approvals.push({
          contract: operator.name,
          address: operator.address,
          approved: isApproved,
        });
      } catch (err) {
        erc1155Approvals.push({
          contract: operator.name,
          address: operator.address,
          approved: false,
        });
        issues.push(`ERC1155: vérification ${operator.name} impossible — ${this.errMsg(err)}`);
      }
    }

    // --- Garde anti-état vide / absent (fail-closed) ------------------------
    // Une liste vide ⇒ la boucle correspondante n'a rien vérifié. `issues` serait
    // vide et `tradingReady` vaudrait `true` alors que RIEN n'a été contrôlé :
    // c'est exactement le mode d'échec « autorisation absente = autorisation
    // ouverte ». On refuse explicitement.
    if (ERC20_SPENDERS.length === 0 || erc20Allowances.length !== ERC20_SPENDERS.length) {
      issues.push(
        `ERC20: contrôle incomplet (${erc20Allowances.length}/${ERC20_SPENDERS.length} dépensiers vérifiés)`
      );
    }
    if (ERC1155_OPERATORS.length === 0 || erc1155Approvals.length !== ERC1155_OPERATORS.length) {
      issues.push(
        `ERC1155: contrôle incomplet (${erc1155Approvals.length}/${ERC1155_OPERATORS.length} opérateurs vérifiés)`
      );
    }

    // --- Détermination des manques -----------------------------------------
    for (const a of erc20Allowances) {
      if (!a.approved) {
        issues.push(`ERC20: ${a.contract} needs USDC approval`);
      }
    }
    for (const a of erc1155Approvals) {
      if (!a.approved) {
        issues.push(`ERC1155: ${a.contract} needs approval for Conditional Tokens`);
      }
    }

    const tradingReady = issues.length === 0;

    return {
      wallet: walletAddress,
      usdcBalance: balanceFormatted,
      erc20Allowances,
      erc1155Approvals,
      tradingReady,
      issues,
    };
  }

  /** Message d'erreur borné (évite les dumps ethers de plusieurs Ko). */
  private errMsg(err: unknown, maxLen = 200): string {
    const raw = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
    return raw.length <= maxLen ? raw : raw.slice(0, maxLen) + '…';
  }

  /**
   * Set up all required approvals for trading
   *
   * @returns Results of all approval transactions
   */
  async approveAll(): Promise<ApprovalsResult> {
    const walletAddress = this.signer.address;

    const usdc = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, this.signer);
    const conditionalTokens = new ethers.Contract(CONDITIONAL_TOKENS, ERC1155_ABI, this.signer);

    // Get gas price with buffer
    const gasPrice = await this.provider.getGasPrice();
    const adjustedGasPrice = gasPrice.mul(150).div(100); // 1.5x

    // Process ERC20 approvals
    const erc20Results: ApprovalTxResult[] = [];
    for (const spender of ERC20_SPENDERS) {
      // Check current allowance
      const allowance = await usdc.allowance(walletAddress, spender.address);
      const allowanceNum = parseFloat(ethers.utils.formatUnits(allowance, 6));

      if (allowanceNum > 1e12) {
        // Already approved
        erc20Results.push({
          contract: spender.name,
          success: true,
        });
        continue;
      }

      try {
        const tx = await usdc.approve(spender.address, ethers.constants.MaxUint256, {
          gasPrice: adjustedGasPrice,
        });
        await tx.wait();
        erc20Results.push({
          contract: spender.name,
          txHash: tx.hash,
          success: true,
        });
      } catch (err) {
        erc20Results.push({
          contract: spender.name,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    // Process ERC1155 approvals
    const erc1155Results: ApprovalTxResult[] = [];
    for (const operator of ERC1155_OPERATORS) {
      // Check current approval
      const isApproved = await conditionalTokens.isApprovedForAll(walletAddress, operator.address);

      if (isApproved) {
        // Already approved
        erc1155Results.push({
          contract: operator.name,
          success: true,
        });
        continue;
      }

      try {
        const tx = await conditionalTokens.setApprovalForAll(operator.address, true, {
          gasPrice: adjustedGasPrice,
          gasLimit: 100000,
        });
        await tx.wait();
        erc1155Results.push({
          contract: operator.name,
          txHash: tx.hash,
          success: true,
        });
      } catch (err) {
        erc1155Results.push({
          contract: operator.name,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const allApproved =
      ERC20_SPENDERS.length > 0 &&
      ERC1155_OPERATORS.length > 0 &&
      erc20Results.length === ERC20_SPENDERS.length &&
      erc1155Results.length === ERC1155_OPERATORS.length &&
      erc20Results.every((r) => r.success) &&
      erc1155Results.every((r) => r.success);

    const newApprovals = [...erc20Results, ...erc1155Results].filter((r) => r.txHash).length;

    return {
      wallet: walletAddress,
      erc20Approvals: erc20Results,
      erc1155Approvals: erc1155Results,
      allApproved,
      summary: allApproved
        ? newApprovals > 0
          ? `All approvals set. ${newApprovals} new approval(s) submitted.`
          : 'All approvals already set. Ready to trade.'
        : 'Some approvals failed. Check the results for details.',
    };
  }

  /**
   * Approve USDC spending for a specific contract
   *
   * @param spenderAddress - The contract address to approve
   * @param amount - The amount to approve (default: unlimited)
   */
  async approveUsdc(
    spenderAddress: string,
    amount: ethers.BigNumber = ethers.constants.MaxUint256
  ): Promise<ApprovalTxResult> {
    const usdc = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, this.signer);
    const gasPrice = await this.provider.getGasPrice();

    try {
      const tx = await usdc.approve(spenderAddress, amount, {
        gasPrice: gasPrice.mul(150).div(100),
      });
      await tx.wait();
      return {
        contract: spenderAddress,
        txHash: tx.hash,
        success: true,
      };
    } catch (err) {
      return {
        contract: spenderAddress,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  /**
   * Set approval for an ERC1155 operator
   *
   * @param operatorAddress - The operator address to approve
   * @param approved - Whether to approve or revoke
   */
  async setErc1155Approval(
    operatorAddress: string,
    approved: boolean = true
  ): Promise<ApprovalTxResult> {
    const conditionalTokens = new ethers.Contract(CONDITIONAL_TOKENS, ERC1155_ABI, this.signer);
    const gasPrice = await this.provider.getGasPrice();

    try {
      const tx = await conditionalTokens.setApprovalForAll(operatorAddress, approved, {
        gasPrice: gasPrice.mul(150).div(100),
        gasLimit: 100000,
      });
      await tx.wait();
      return {
        contract: operatorAddress,
        txHash: tx.hash,
        success: true,
      };
    } catch (err) {
      return {
        contract: operatorAddress,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }
}
