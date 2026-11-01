import { createConnectors } from "./connector-contract.mjs";
import { getConnectorBinding } from "./connector-context";
export function connectorsForRequest() {
    return createConnectors(getConnectorBinding());
}
export type { ConnectorContext, ConnectorResult, ConnectorFailureStatus, Json, } from "./connector-contract.mjs";
