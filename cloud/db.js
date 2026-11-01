export function database(binding) {
    const connection = binding.withSession ? binding.withSession("first-primary") : binding;
    function prepare(sql) {
        function bind(args) {
            let query = sql;
            let values = args;
            if (args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0])) {
                values = [];
                query = sql.replace(/:([a-z_]+)/g, (_, name) => {
                    values.push(args[0][name] ?? null);
                    return "?";
                });
            }
            return connection.prepare(query).bind(...values);
        }
        return {
            statement: (...args) => bind(args),
            get: (...args) => bind(args).first(),
            all: async (...args) => (await bind(args).all()).results,
            run: async (...args) => {
                const result = await bind(args).run();
                return { ...result, changes: result.meta.changes };
            }
        };
    }
    return { prepare, batch: (statements) => connection.batch(statements) };
}
export async function getMeta(db, key) {
    return (await db.prepare("SELECT value FROM meta WHERE key = ?").get(key))?.value ?? null;
}
export async function setMeta(db, key, value) {
    await db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}
