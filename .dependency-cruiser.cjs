/** Module boundaries for the modular monolith. Fails `pnpm lint` on violation. */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: { path: '^apps/api/src/' },
      to: { circular: true },
    },
    {
      name: 'module-internals-are-private',
      comment: 'A module may use another module only through its public index.ts.',
      severity: 'error',
      from: { path: '^apps/api/src/modules/([^/]+)/' },
      to: {
        path: '^apps/api/src/modules/[^/]+/(domain|application|infrastructure|interfaces)/',
        pathNot: '^apps/api/src/modules/$1/',
      },
    },
    {
      name: 'domain-is-framework-free',
      comment: 'Domain code holds rules only: no framework, database or protocol imports.',
      severity: 'error',
      from: { path: '^apps/api/src/modules/[^/]+/domain/' },
      to: {
        path: 'node_modules/(@nestjs|drizzle-orm|fastify|pg|@electric-sql|@modelcontextprotocol|@a2a-js|bullmq|nats|kafkajs)/',
      },
    },
    {
      name: 'domain-does-not-reach-out',
      severity: 'error',
      from: { path: '^apps/api/src/modules/[^/]+/domain/' },
      to: { path: '^apps/api/src/modules/[^/]+/(application|infrastructure|interfaces)/' },
    },
    {
      name: 'shared-does-not-depend-on-modules',
      severity: 'error',
      from: { path: '^apps/api/src/shared/' },
      to: { path: '^apps/api/src/modules/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.spec\\.ts$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'apps/api/tsconfig.json' },
    enhancedResolveOptions: {
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
