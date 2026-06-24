/**
 * Tool registry entry point. Importing this module guarantees the audience-grouped
 * handler modules have run their `register(...)` side effects, so `REGISTRY` is
 * fully populated before any `runTool` / `deriveOfferedTools` call.
 */
import './clientTools';

export {
    runTool,
    deriveOfferedTools,
    makeClientResolvers,
    entryAllowed,
    REGISTRY,
    DENIED,
    type ToolContext,
    type ToolEntry,
    type DynamicsPort,
    type ClientResolveResult,
    type EntityType,
} from './registry';
