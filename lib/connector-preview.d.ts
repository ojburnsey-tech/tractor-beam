declare module "virtual:sites-connector-preview" {
    const binding: import("./connector-contract.mjs").ConnectorBinding;
    export default binding;
}
declare namespace Cloudflare {
    interface Env {
        CONNECTORS?: import("./connector-contract.mjs").ConnectorBinding;
    }
}
