export interface CompanionAuthStatus { valid: boolean | null; expiresAt: number | null; checkedAt: number | null }
export interface CompanionAuthChecker { check(options?: { force?: boolean }): Promise<CompanionAuthStatus>; last(): CompanionAuthStatus }
