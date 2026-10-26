/**
 * TTTFG-4830 (voice notes): a WhatsApp voice note as text, for the claims demo (src/domain/claimsDemoHost.ts reads the
 * text as what the client said; the claims package tells Claude it is a transcript).
 *
 * Claude can't take audio, so speech recognition comes first: OpenAI's transcription API, on the OPENAI_API_KEY Tina
 * already has for embeddings. It takes WhatsApp's voice notes (audio/ogg, Opus) as they come, so nothing is converted.
 * Settings:
 *   CLAIMS_TRANSCRIBE_MODEL     default gpt-4o-transcribe (gpt-4o-mini-transcribe: half the price, a little less exact)
 *   CLAIMS_TRANSCRIBE_LANGUAGE  an ISO-639-1 code to fix the language (unset: detected, so Afrikaans works too)
 *   CLAIMS_VOICE_MAX_SECONDS    longer voice notes are refused before anything is sent (default 600)
 * Cost: about $0.006 a minute on gpt-4o-transcribe ($0.003 on mini); a 30-second note takes a second or two.
 */
import OpenAI, { toFile } from 'openai';

const DEFAULT_MODEL = 'gpt-4o-transcribe';
const DEFAULT_MAX_SECONDS = 600;
/** Without a duration (not Ogg), the size stands in for it: about 16 MB is WhatsApp's own limit for audio. */
const MAX_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

/**
 * The audio types the transcription API takes, by WhatsApp's mime type (parameters such as "; codecs=opus" dropped),
 * with the file name it is sent under (the API goes by the extension). WhatsApp's audio/amr and audio/aac are not here.
 */
const EXTENSIONS: Record<string, string> = {
    'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/flac': 'flac',
};

export type Transcribed =
    | { text: string; seconds: number | null; model: string; ms: number }
    | { problem: 'unclear' | 'too-long' | 'unsupported'; seconds: number | null };

/**
 * An Ogg file's length in seconds, from the granule position of its last page (Opus counts 48 kHz samples), or null
 * when the bytes aren't Ogg. Read from the header only, so nothing is decoded.
 */
export function oggSeconds(bytes: Buffer): number | null {
    if (bytes.length < 27 || bytes.toString('latin1', 0, 4) !== 'OggS') return null;
    const last = bytes.lastIndexOf('OggS', bytes.length - 27, 'latin1');
    if (last < 0) return null;
    const granule = Number(bytes.readBigUInt64LE(last + 6));
    // 2^64 - 1 marks a page with no finished packet; a real voice note's last page always has one.
    return granule > 0 && granule < Number.MAX_SAFE_INTEGER ? Math.round((granule / 48_000) * 10) / 10 : null;
}

let client: OpenAI | undefined;
const openai = () => {
    if (!process.env.OPENAI_API_KEY) throw new Error('[Transcribe] OPENAI_API_KEY is not set');
    return (client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 2, timeout: TIMEOUT_MS }));
};

/**
 * The voice note's words. `hint`: what the client is answering (claimsDemoHost voiceHint). A refused note
 * (`problem`) costs nothing; a service failure throws, for the caller to answer.
 */
export async function transcribeVoiceNote(bytes: Buffer, mimeType: string, hint: string): Promise<Transcribed> {
    const type = mimeType.split(';')[0].trim().toLowerCase();
    const ext = EXTENSIONS[type];
    const seconds = type === 'audio/ogg' || type === 'audio/opus' ? oggSeconds(bytes) : null;
    if (!ext) return { problem: 'unsupported', seconds };
    const max = Number(process.env.CLAIMS_VOICE_MAX_SECONDS) > 0 ? Number(process.env.CLAIMS_VOICE_MAX_SECONDS) : DEFAULT_MAX_SECONDS;
    if ((seconds ?? 0) > max || bytes.length > MAX_BYTES) return { problem: 'too-long', seconds };

    const model = process.env.CLAIMS_TRANSCRIBE_MODEL?.trim() || DEFAULT_MODEL;
    const language = process.env.CLAIMS_TRANSCRIBE_LANGUAGE?.trim() || undefined;
    const started = Date.now();
    const res = await openai().audio.transcriptions.create({
        file: await toFile(bytes, `voice-note.${ext}`, { type }),
        model,
        prompt: hint,
        ...(language ? { language } : {}),
        response_format: 'json',
    });
    const text = (res.text ?? '').trim();
    if (!text || echoesHint(text, hint)) return { problem: 'unclear', seconds };
    return { text, seconds, model, ms: Date.now() - started };
}

/**
 * Silence can come back as the hint's own words: nothing the client said. Only a long stretch counts, so a short answer
 * that happens to be in the hint ("Toyota", from "For example Toyota or VW") is kept.
 */
export function echoesHint(text: string, hint: string): boolean {
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length >= 30 && hint.includes(t);
}
