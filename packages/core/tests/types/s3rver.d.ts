/**
 * s3rver n'embarque pas de types — surface minimale utilisée par les tests
 * d'intégration storage (devDependency, jamais embarquée dans le build).
 */
declare module 's3rver' {
  export default class S3rver {
    constructor(options: Record<string, unknown>);
    run(): Promise<unknown>;
    close(): Promise<unknown>;
    httpServer: unknown;
  }
}
