type PoolQueryInput = string | { sql: string; values?: unknown[]; timeout?: number; rowsAsArray?: boolean };

type PoolLike = {
	query<T = unknown>(_input: PoolQueryInput, _values?: unknown[]): Promise<[T, unknown]>;
};

function notImplemented(): never {
	throw new Error("mysql2 stub should not execute real queries in self-check.");
}

const mysql = {
	createPool(): PoolLike {
		return {
			async query() {
				return notImplemented();
			},
		};
	},
};

export type Pool = PoolLike;
export type RowDataPacket = Record<string, unknown>;
export type ResultSetHeader = {
	affectedRows: number;
};
export default mysql;
