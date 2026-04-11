// ─── Table Kinds ─────────────────────────────────────────────────────────────

export type TableKind =
  | "loot"
  | "encounter"
  | "critical"
  | "fumble"
  | "reward"
  | "status"
  | "event"
  | "custom";

// ─── Conditions ──────────────────────────────────────────────────────────────

export type ConditionType = "compare" | "nat" | "tag" | "context";

export interface CompareCondition {
  type: "compare";
  /** Compare the triggering roll total against a threshold. */
  operator: "=" | ">" | ">=" | "<" | "<=";
  value: number;
}

export interface NatCondition {
  type: "nat";
  /** Compare a specific natural die value (e.g., nat 20). */
  operator: "=" | ">" | ">=" | "<" | "<=";
  value: number;
}

export interface TagCondition {
  type: "tag";
  /** Entry is eligible only if this tag is present in context. */
  tag: string;
}

export interface ContextCondition {
  type: "context";
  /** Test a named context variable. */
  variable: string;
  operator: "=" | ">" | ">=" | "<" | "<=";
  value: number | string;
}

export type TableCondition =
  | CompareCondition
  | NatCondition
  | TagCondition
  | ContextCondition;

// ─── Table Entries ───────────────────────────────────────────────────────────

export interface TableEntry {
  name: string;
  weight: number;
  description?: string;

  /** Dice expression evaluated on selection (e.g., "2d6*10" for gold). */
  roll?: string;
  /** Dice expression for quantity (e.g., "1d4"). */
  quantity?: string;
  /** Dice expression for duration in turns/rounds (e.g., "1d4+1"). */
  duration?: string;

  /** Nested table reference — recurses into another table. */
  table?: string;
  /** Chain: after this entry resolves, also roll on these tables. */
  chain?: string[];

  /** Conditions that must ALL pass for this entry to be eligible. */
  conditions?: TableCondition[];

  /** Metadata */
  tags?: string[];
  rarity?: "common" | "uncommon" | "rare" | "epic" | "legendary";
  minLevel?: number;
  maxLevel?: number;
}

// ─── Tables ──────────────────────────────────────────────────────────────────

export interface GameTable {
  table: string;
  kind: TableKind;
  entries: TableEntry[];

  /** Optional dice expression to roll for index-based lookup (e.g., "1d100"). */
  rollExpression?: string;
  /** Allow the same entry to be selected multiple times in multi-roll. */
  allowDuplicates?: boolean;
  /** Tags for table filtering/grouping. */
  tags?: string[];
}

// ─── Context ─────────────────────────────────────────────────────────────────

export interface TableContext {
  level?: number;
  tags?: string[];
  variables?: Record<string, number | string>;
  /** The result of the triggering dice roll (if any). */
  triggerRoll?: number;
  /** Natural die value from trigger (for nat conditions). */
  triggerNat?: number;
}

// ─── Results ─────────────────────────────────────────────────────────────────

export interface TableResult {
  entry: string;
  description?: string;
  quantity: number;
  rollValue?: number;
  rollExpression?: string;
  duration?: number;
  durationExpression?: string;
  fromTable: string;
  rarity?: string;
  tags?: string[];
  /** Results from chained tables. */
  chainResults?: TableResult[];
}

// ─── Collection ──────────────────────────────────────────────────────────────

export interface GameTableCollection {
  version: "2.0";
  tables: GameTable[];
  metadata?: Record<string, unknown>;
}
