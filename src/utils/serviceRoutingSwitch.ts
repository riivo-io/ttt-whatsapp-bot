/**
 * Service routing's switch (docs/PLAN-service-routing.md). Off unless SERVICE_ROUTING_ENABLED=true;
 * SERVICE_ROUTING_NUMBERS (comma-separated, optional) limits it to those numbers. Tina's main deploys to PROD on every
 * push, so routing is tried on our own phones first. Its own module: claude.service.ts reads it too (the tax prompt's
 * insurance line), without importing the routing service.
 */
const digits = (p: string) => p.replace(/\D/g, '').replace(/^0/, '27');

export function serviceRoutingOn(phone: string, env: NodeJS.ProcessEnv = process.env): boolean {
    if ((env.SERVICE_ROUTING_ENABLED ?? '').trim().toLowerCase() !== 'true') return false;
    const list = (env.SERVICE_ROUTING_NUMBERS ?? '').split(',').map((n) => digits(n.trim())).filter(Boolean);
    return list.length === 0 || list.includes(digits(phone));
}
