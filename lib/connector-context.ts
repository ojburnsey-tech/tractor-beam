import { AsyncLocalStorage } from "node:async_hooks";
import type { ConnectorBinding } from "./connector-contract.mjs";
const bindings = new AsyncLocalStorage<ConnectorBinding | undefined>();
export function runWithConnectorBinding<T>(binding: ConnectorBinding | undefined, run: () => T): T {
    return bindings.run(binding, run);
}
export function getConnectorBinding(): ConnectorBinding | undefined {
    return bindings.getStore();
}
