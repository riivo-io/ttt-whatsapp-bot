/**
 * Tool registry entry point. Importing this module guarantees the audience-grouped
 * handler modules have run their `register(...)` side effects, so `REGISTRY` is
 * fully populated before any `runTool` / `deriveOfferedTools` call.
 */
import './clientTools';
import './staffTools';
import './leadTools';

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
    type TaxFaqPort,
    type MetaPort,
    type PdfPort,
    type GraphMailPort,
    type SupabasePort,
    type FormsPort,
    type Irp5Port,
    type LoeOcrPort,
    type LoeExtractedFields,
    type PendingUploadState,
    type PendingLoeState,
    type ClientResolveResult,
    type EntityType,
} from './registry';
