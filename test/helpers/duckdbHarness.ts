import { DuckDBEngine } from "../../src/duckdbEngine";

export interface EngineHarness {
  engine: DuckDBEngine;
  dispose: () => void;
}

export async function createEngine(): Promise<EngineHarness> {
  const engine = new DuckDBEngine();
  await engine.init();
  return {
    engine,
    dispose: () => engine.dispose(),
  };
}
