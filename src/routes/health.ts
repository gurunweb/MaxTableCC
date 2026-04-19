import type { FastifyPluginAsync } from 'fastify';

interface Options {
  version: string;
  startTime: number;
}

export const healthRoute: FastifyPluginAsync<Options> = async (fastify, opts) => {
  fastify.get('/', async () => ({
    ok: 1,
    version: opts.version,
    uptime: Math.floor((Date.now() - opts.startTime) / 1000),
    node: process.versions.node,
    platform: process.platform,
  }));
};
