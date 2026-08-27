/**
 * TokenBudget - Track and manage token allocation
 *
 * Single responsibility: Manage token budget allocation and tracking
 * No side effects, deterministic allocation
 */
import type {
  TokenBudget as ITokenBudget,
  TokenUsage,
} from "@legioncode/context-assembly";

export class TokenBudget implements ITokenBudget {
  readonly total: number;
  used: number;

  /**
   * Create token budget with specified total
   * @param total - Total token budget
   */
  constructor(total: number) {
    this.total = total;
    this.used = 0;
  }

  /**
   * Get remaining budget
   * @returns Remaining tokens (never negative)
   */
  get remaining(): number {
    return Math.max(0, this.total - this.used);
  }

  /**
   * Get total allocated tokens (including overages from forceAllocate)
   * @returns Number of tokens allocated
   */
  allocated(): number {
    return this.used;
  }

  /**
   * Attempt to allocate tokens
   * @param amount - Amount to allocate
   * @returns Whether allocation succeeded (won't exceed budget)
   */
  allocate(amount: number): boolean {
    if (amount <= 0) {
      return true;
    }

    if (this.used + amount > this.total) {
      return false;
    }

    this.used += amount;
    return true;
  }

  /**
   * Force allocation (exceeds budget if needed)
   * @param amount - Amount to allocate
   */
  forceAllocate(amount: number): void {
    this.used += Math.max(0, amount);
  }

  /**
   * Get usage statistics
   * @returns Token usage breakdown with percentage
   */
  getUsage(): TokenUsage {
    return {
      used: this.used,
      total: this.total,
      percentage: this.total > 0 ? (this.used / this.total) * 100 : 0,
    };
  }
}
