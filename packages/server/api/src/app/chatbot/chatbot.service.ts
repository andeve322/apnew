import { safeHttp } from '@activepieces/server-utils'
import { apId, isNil } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { pieceMetadataService } from '../pieces/metadata/piece-metadata-service'

export const chatbotService = {
    async chat({ message, history, log }: { message: string, history: any[], log: FastifyBaseLogger }) {
        const apiKey = process.env.CHATBOT_API_KEY || process.env.GROQ_API_KEY
        if (isNil(apiKey)) {
            throw new Error('CHATBOT_API_KEY or GROQ_API_KEY is not configured in the environment')
        }

        // Fetch piece list
        const piecesSummary = await pieceMetadataService(log).list({
            includeHidden: false,
        })

        // Core pieces that are ALWAYS useful for any workflow
        const corePiecesNames = [
            'gmail', 'google-sheets', 'schedule', 'http', 'ai', 'mcp', 'openai', 
            'google-gemini', 'claude', 'approval', 'utility', 'delay', 'crypto', 
            'storage', 'data-mapper', 'connections', 'csv'
        ]

        const getRelevantPieces = (prompt: string, summary: any[]) => {
            const msg = prompt.toLowerCase()
            // Extract potential keywords from the prompt (words > 3 chars)
            const keywords = msg.split(/\W+/).filter(w => w.length > 3)
            
            const scored = summary.map(p => {
                let score = 0
                const name = p.name.replace('@activepieces/piece-', '').toLowerCase()
                const displayName = p.displayName.toLowerCase()
                const categories = (p.categories || []).map((c: string) => c.toLowerCase())

                // 1. Core Priority
                if (corePiecesNames.includes(name)) score += 100

                // 2. Exact Match in Name or Display Name
                if (msg.includes(name) || msg.includes(displayName)) score += 50
                
                // 3. Partial/Keyword Match
                for (const keyword of keywords) {
                    if (name.includes(keyword) || displayName.includes(keyword)) score += 20
                }

                // 4. Category Intelligence
                if (msg.includes('social') || msg.includes('chat') || msg.includes('messaggio')) {
                    if (categories.includes('communication') || categories.includes('social media')) score += 15
                }
                if (msg.includes('file') || msg.includes('cartella') || msg.includes('drive')) {
                    if (categories.includes('content management') || categories.includes('file management')) score += 15
                }
                if (msg.includes('pagamento') || msg.includes('soldi') || msg.includes('fattura')) {
                    if (categories.includes('payment processing') || categories.includes('accounting')) score += 15
                }

                return { piece: p, score }
            })

            return scored
                .filter(s => s.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, 45) // Take top 45 most relevant pieces
                .map(s => s.piece)
        }

        const selectedPieces = getRelevantPieces(message, piecesSummary)

        const fullPieces = await Promise.all(
            selectedPieces.map(async (p) => {
                try {
                    const metadata = await pieceMetadataService(log).get({
                        name: p.name,
                        version: p.version,
                    });
                    return metadata;
                } catch (e) {
                    log.error(`[ChatbotService] Failed to fetch metadata for piece ${p.name}: ${e}`);
                    return undefined;
                }
            })
        );

        const simplifiedPieces = fullPieces.filter(p => !isNil(p)).map(p => {
            log.info(`[ChatbotService] RAG selected: ${p!.name}`);
            const mapInputProps = (items: Record<string, any>) => {
                const result: Record<string, any> = {}
                for (const [key, item] of Object.entries(items)) {
                    const entries = Object.entries(item.props || {})
                    result[key] = {
                        description: item.description,
                        displayName: item.displayName,
                        props: Object.fromEntries(entries.map(([k, prop]: [string, any]) => [
                            k,
                            {
                                displayName: prop.displayName,
                                description: prop.description,
                                type: prop.type,
                                required: !!prop.required,
                            },
                        ])),
                    }
                }
                return result
            }

            const mapOutputFields = (items: Record<string, any>) => {
                const result: Record<string, string[]> = {}
                for (const [key, item] of Object.entries(items)) {
                    const sample = (item as any).sampleData
                    if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
                        result[key] = Object.keys(sample)
                    }
                }
                return result
            }

            return {
                name: p!.name,
                displayName: p!.displayName,
                description: p!.description,
                version: p!.version,
                actions: mapInputProps(p!.actions),
                triggers: mapInputProps(p!.triggers),
                outputs: mapOutputFields(p!.actions),
            }
        })

        log.info(`Chatbot identified ${simplifiedPieces.length} relevant pieces for the prompt`)

        const messages: any[] = [
            {
                role: 'system',
                content: `You are an expert Activepieces workflow architect. Your job is to design and generate correct, complete, production-ready workflow JSON.

══════════════════════════════════════════════
CRITICAL GOAL: NO UNNECESSARY QUESTIONS
══════════════════════════════════════════════
- You MUST distinguish between STATIC DATA (emails, names) and DYNAMIC DATA (IDs, generated values).
- NEVER ask the user for IDs (spreadsheetId, worksheetId, folderId, item_id) if a previous step generates them.
- Use the {{STEP_NAME.FIELD}} syntax to map outputs automatically.
- If you see a piece that requires an ID (like Google Sheets), check if you can add a 'Create' or 'List' step before it to get that ID dynamically.
- ONLY ask questions for truly missing personal information (e.g., 'What is the recipient email?').

══════════════════════════════════════════════
STRICT STRUCTURAL RULES
══════════════════════════════════════════════
- Step types: EMPTY (trigger only), PIECE_TRIGGER, PIECE, LOOP_ON_ITEMS, BRANCH.
- Every step/trigger MUST have "valid": true.
- Gmail fields (receiver, cc, etc.) MUST be arrays: ["email@example.com"].
- Google Sheets 'insert_row' values MUST be an object: {"Column Name": "Value"}.
- nextAction MUST be nested inside the step, NEVER at the JSON root.
- Loop variables: ALWAYS {{LOOP_NAME.item.field}}. (No 'steps.' prefix, no '.output' in the middle)
- Trigger variables: ALWAYS {{trigger.FIELD}}. (No 'steps.' prefix, no '.output' in the middle)
- Action variables: ALWAYS {{STEP_NAME.FIELD}}. (No 'steps.' prefix, no '.output' in the middle)
- JSON values: Ensure all field values are valid JSON types.
- After the final action, include a mandatory "publish" step (\`type":"PUBLISH"\`) with "valid": true to enable workflow activation.
- TRIGGER STRUCTURE: If the workflow starts with a piece (like Schedule, Gmail, Webhook), the top-level "trigger" MUST have "type": "PIECE_TRIGGER". 
- NEVER put a "PIECE_TRIGGER" inside a "nextAction". 
- "type": "EMPTY" should ONLY be used if there is no specific piece trigger applicable.
- Omit any optional piece input fields that are empty, null, or undefined; do not include them in the JSON at all.

══════════════════════════════════════════════
CONTROL FLOW STRUCTURES (CRITICAL)
══════════════════════════════════════════════
- LOOP_ON_ITEMS: 
  "type": "LOOP_ON_ITEMS",
  "settings": { "items": "{{ expression_returning_array }}" },
  "firstLoopAction": { ... first action inside loop ... },
  "nextAction": { ... next action after loop finishes ... }

- BRANCH:
  "type": "BRANCH",
  "settings": {
    "conditions": [
      [{ "operator": "TEXT_CONTAINS", "firstValue": "{{ val }}", "secondValue": "match" }]
    ]
  },
  "onTrueNextAction": { ... action if condition is true ... },
  "onFalseNextAction": { ... action if condition is false ... },
  "nextAction": { ... action after branch branches converge ... }

══════════════════════════════════════════════
AGENTIC WORKFLOWS & AI PIECES
══════════════════════════════════════════════
- For complex tasks requiring reasoning or multiple tools, use the '@activepieces/piece-ai' piece with the 'run_agent' action.
- 'run_agent' takes a 'prompt' and 'agentTools'.
- 'agentTools' is an array where each tool object MUST have:
  - "type": "PIECE"
  - "toolName": (the name of the piece to use as a tool, e.g., "@activepieces/piece-google-sheets")
- Example 'run_agent' tool: {"type": "PIECE", "toolName": "@activepieces/piece-slack"}
- Use 'run_agent' when the user wants an "AI Assistant", "Agent", or complex decision-making.

AVAILABLE PIECES:
${JSON.stringify(simplifiedPieces)}

══════════════════════════════════════════════
EXAMPLE 1 — Simple: Send email (EMPTY trigger)
══════════════════════════════════════════════
\`\`\`json
{
  "displayName": "Invia Email",
  "trigger": {
    "name": "trigger",
    "type": "EMPTY",
    "valid": true,
    "displayName": "Trigger",
    "settings": { "propertySettings": {} },
    "nextAction": {
      "name": "invia_email",
      "type": "PIECE",
      "valid": true,
      "displayName": "Invia Email",
      "settings": {
        "pieceName": "@activepieces/piece-gmail",
        "pieceVersion": "0.0.1",
        "actionName": "send_email",
        "input": {
          "subject": "Ciao!",
          "receiver": ["email@example.com"],
          "body": "Testo della mail."
        },
        "propertySettings": {}
      }
    }
  }
}
\`\`\`

══════════════════════════════════════════════
EXAMPLE 2 — Complex: Create a new Google Sheet, fetch 10 seismic events, insert each as a row via LOOP
══════════════════════════════════════════════
Planning (ZERO USER INTERACTION REQUIRED - ALL IDs ARE DYNAMIC):
  Step 1: Create a new spreadsheet → output.spreadsheetId is available
  Step 2: Create a worksheet inside it → output.worksheetId is available
  Step 3: Fetch list of earthquakes → output is an array
  Step 4: LOOP over each earthquake (LOOP_ON_ITEMS)
  Step 5: Inside loop → insert one row. Use {{xxx.field}} for IDs.

KEY RULE: spreadsheetId and worksheetId come from previous steps. Use {{crea_foglio.spreadsheetId}} and {{crea_worksheet.worksheetId}}.

\`\`\`json
{
  "displayName": "Terremoti su Google Sheets",
  "trigger": {
    "name": "trigger",
    "type": "EMPTY",
    "valid": true,
    "settings": {},
    "nextAction": {
      "name": "crea_foglio",
      "type": "PIECE",
      "valid": true,
      "settings": {
        "pieceName": "@activepieces/piece-google-sheets",
        "actionName": "create-spreadsheet",
        "input": { "title": "Terremoti" }
      },
      "nextAction": {
        "name": "loop_terremoti",
        "type": "LOOP_ON_ITEMS",
        "valid": true,
        "settings": { "items": "{{fetch}}" },
        "firstLoopAction": {
          "name": "insert",
          "type": "PIECE",
          "valid": true,
          "settings": {
            "pieceName": "@activepieces/piece-google-sheets",
            "actionName": "insert_row",
            "input": {
              "spreadsheetId": "{{crea_foglio.spreadsheetId}}",
              "values": { "Mag": "{{loop_terremoti.item.mag}}" }
            }
          }
        }
      }
    }
  }
}
\`\`\`

- Output ONLY the JSON block inside \`\`\`json \`\`\` followed by a short summary.`,
            },
            ...history,
            { role: 'user', content: message },
        ]

        const baseUrl = process.env.CHATBOT_BASE_URL || 'https://api.groq.com/openai/v1'
        const model = process.env.CHATBOT_MODEL || 'llama-3.3-70b-versatile'

        const callLlm = async (modelName: string) => {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            }

            const cleanBaseUrl = baseUrl.replace(/\/$/, '')
            const url = cleanBaseUrl.endsWith('/chat/completions') 
                ? cleanBaseUrl 
                : `${cleanBaseUrl}/chat/completions`

            return safeHttp.axios.post(
                url,
                {
                    model: modelName,
                    messages,
                    temperature: 0.3,
                },
                { headers, timeout: 300000 },
            )
        }

        try {
            log.info({ baseUrl, model }, 'Attempting to call LLM provider')
            const response = await callLlm(model)

            let reply = response.data.choices[0].message.content
            let flowJson = null

            // Helper to clean "dirty" JSON from LLMs
            const cleanDirtyJson = (str: string) => {
                let cleaned = str
                    .replace(/\/\/.*$/gm, '')         // Remove single-line comments
                    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
                    .replace(/,(\s*[}\]])/g, '$1')    // Remove trailing commas
                    .trim()

                // Auto-close unclosed braces/brackets — LLMs often truncate long JSON
                let braces = 0
                let brackets = 0
                let inString = false
                let escape = false
                for (const ch of cleaned) {
                    if (escape) {
                        escape = false; continue 
                    }
                    if (ch === '\\') {
                        escape = true; continue 
                    }
                    if (ch === '"') {
                        inString = !inString; continue 
                    }
                    if (inString) continue
                    if (ch === '{') braces++
                    else if (ch === '}') braces--
                    else if (ch === '[') brackets++
                    else if (ch === ']') brackets--
                }
                cleaned += ']'.repeat(Math.max(0, brackets))
                cleaned += '}'.repeat(Math.max(0, braces))

                return cleaned
            }

            // 1. Try to extract from markdown blocks (more flexible regex)
            const markdownMatches = [...reply.matchAll(/```(?:json|JSON|)?\s*(\{[\s\S]*?\})\s*```/gi)]
            for (const match of markdownMatches) {
                try {
                    const candidate = JSON.parse(cleanDirtyJson(match[1]))
                    if (candidate.trigger || candidate.flows) {
                        flowJson = candidate
                        reply = reply.replace(match[0], '').trim()
                        break
                    }
                }
                catch (e) {
                    log.error(`Failed to parse markdown JSON: ${e}`)
                }
            }

            // 2. Fallback: search for the widest possible JSON-like structure
            if (!flowJson) {
                const firstBrace = reply.indexOf('{')
                const lastBrace = reply.lastIndexOf('}')
                
                if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                    const candidateStr = reply.substring(firstBrace, lastBrace + 1)
                    try {
                        const candidate = JSON.parse(cleanDirtyJson(candidateStr))
                        if (candidate.trigger || candidate.flows) {
                            flowJson = candidate
                            reply = (reply.substring(0, firstBrace) + reply.substring(lastBrace + 1)).trim()
                        }
                    }
                    catch (e) {
                        log.error(`Failed to parse widest-range JSON: ${e}`)
                    }
                }
            }

            if (!reply || reply.length < 5) {
                reply = 'I\'ve generated the workflow for you! Click the button below to apply it.'
            }

            // Normalize structure: LLMs often put nextAction at root level instead of inside trigger.
            // Move it into trigger.nextAction where Activepieces expects it.
            if (flowJson && flowJson.trigger && flowJson.nextAction && !flowJson.trigger.nextAction) {
                log.info('[ChatbotService] Migrating root-level nextAction into trigger.nextAction')
                flowJson.trigger.nextAction = flowJson.nextAction
                delete flowJson.nextAction
            }

            // Auto-fix piece versions to prevent 400/404 errors due to LLM hallucinations
            if (flowJson && flowJson.trigger) {
                // Fix nested triggers (LLM often puts a PIECE_TRIGGER inside an EMPTY trigger)
                if (flowJson.trigger.type === 'EMPTY' && flowJson.trigger.nextAction?.type === 'PIECE_TRIGGER') {
                    log.info('[ChatbotService#fixVersions] Promoting nested trigger to root')
                    const nestedTrigger = flowJson.trigger.nextAction
                    const oldNextAction = nestedTrigger.nextAction
                    flowJson.trigger = {
                        ...nestedTrigger,
                        name: 'trigger',
                        nextAction: oldNextAction,
                    }
                }

                const fixVersions = (step: any, parent?: any, key?: string) => {
                    if (isNil(step)) return

                    // Ensure every step has a valid name and displayName to avoid "stepName undefined" errors in builder
                    if (isNil(step.name)) {
                        step.name = key === 'trigger' ? 'trigger' : `step_${apId()}`
                    }
                    if (isNil(step.displayName)) {
                        step.displayName = step.name
                    }
                    
                    // Recursive helper to fix hallucinated mappings like {{steps.xxx.output.field}} -> {{steps.xxx.field}}
                    const fixMappings = (obj: any): any => {
                        if (isNil(obj)) return obj
                        if (typeof obj === 'string') {
                            // Fix hallucinated mappings: {{steps.xxx.output.field}} or {{steps.xxx.field}} -> {{xxx.field}}
                            return obj.replace(/\{\{\s*(?:steps\.)?([\w_]+)(?:\.output)?\.([\w_.]+)\s*\}\}/g, '{{$1.$2}}')
                        }
                        if (Array.isArray(obj)) {
                            return obj.map(item => fixMappings(item))
                        }
                        if (typeof obj === 'object') {
                            const newObj: any = {}
                            for (const k in obj) {
                                newObj[k] = fixMappings(obj[k])
                            }
                            return newObj
                        }
                        return obj
                    }

                    // Apply mapping fix to the entire step object early
                    const fixedStep = fixMappings(step)
                    Object.assign(step, fixedStep)

                    // Remove steps whose type is not a valid Activepieces action type.
                    const validActionTypes = ['PIECE', 'PIECE_TRIGGER', 'LOOP_ON_ITEMS', 'BRANCH', 'EMPTY']
                    if (!validActionTypes.includes(step.type)) {
                        if (parent && key) {
                            log.warn({ stepName: step.name, type: step.type }, '[ChatbotService#fixVersions] Removing step with invalid type')
                            delete parent[key]
                        }
                        return
                    }

                    // 1. Common initialization for ALL steps
                    if (isNil(step.settings)) step.settings = {}
                    step.valid = true
                    if (isNil(step.displayName)) {
                        step.displayName = step.name.split('_').map((s: string) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ')
                    }

                    // 2. Type-specific logic
                    if (step.type === 'EMPTY') {
                        step.settings = {}
                        step.sampleData = {}
                    }

                    if (step.type === 'LOOP_ON_ITEMS') {
                        // AI MISTAKE: sometimes puts firstLoopAction inside settings. Move it out.
                        if (step.settings?.firstLoopAction) {
                            log.info({ stepName: step.name }, '[ChatbotService#fixVersions] Moving firstLoopAction out of settings')
                            step.firstLoopAction = step.settings.firstLoopAction
                            delete step.settings.firstLoopAction
                        }
                        // LOOP_ON_ITEMS must strictly only have "items" in settings and it MUST be a string (expression)
                        let items = step.settings.items
                        if (Array.isArray(items)) {
                            items = `{{ ${JSON.stringify(items)} }}`
                        }
                        step.settings = { items: items || '' }
                    }

                    if (step.type === 'BRANCH') {
                        // AI MISTAKE: sometimes puts onTrueNextAction/onFalseNextAction inside settings. Move them out.
                        if (step.settings?.onTrueNextAction) {
                            step.onTrueNextAction = step.settings.onTrueNextAction
                            delete step.settings.onTrueNextAction
                        }
                        if (step.settings?.onFalseNextAction) {
                            step.onFalseNextAction = step.settings.onFalseNextAction
                            delete step.settings.onFalseNextAction
                        }
                        // BRANCH must have conditions in settings
                        if (isNil(step.settings.conditions)) {
                            step.settings.conditions = [[{ operator: 'EXISTS', firstValue: '', secondValue: '' }]]
                        }
                    }

                    const isPieceStep = step.type === 'PIECE' || step.type === 'PIECE_TRIGGER'
                    if (isPieceStep) {
                        // Ensure input and propertySettings exist for pieces
                        if (isNil(step.settings.input)) step.settings.input = {}
                        if (isNil(step.settings.propertySettings)) step.settings.propertySettings = {}

                        // Ensure pieceVersion is NEVER undefined to prevent frontend crash
                        step.settings.pieceVersion = step.settings.pieceVersion || '0.0.1'
                        
                        const pieceName = step.settings.pieceName
                        if (pieceName) {
                            const normalizedName = pieceName.replace('@activepieces/piece-', '')
                            const actualPiece = simplifiedPieces.find(
                                (p) =>
                                    p.name === pieceName ||
                                    p.name === `@activepieces/piece-${normalizedName}` ||
                                    p.name.replace('@activepieces/piece-', '') ===
                                        normalizedName,
                            );
                            if (actualPiece) {
                                log.info(
                                    { pieceName, actualName: actualPiece.name },
                                    '[ChatbotService#fixVersions] Piece found',
                                );
                                step.settings.pieceName = actualPiece.name;
                                step.settings.pieceVersion =
                                    (actualPiece as any).version ||
                                    step.settings.pieceVersion;

                                // Auto-fix for Gmail piece: convert email strings to arrays if necessary
                                const isGmail =
                                    actualPiece.name === '@activepieces/piece-gmail' ||
                                    actualPiece.name === 'gmail';
                                if (isGmail) {
                                    const arrayFields = ['receiver', 'cc', 'bcc', 'reply_to'];
                                    arrayFields.forEach((field) => {
                                        const value = step.settings.input[field];
                                        if (value && typeof value === 'string') {
                                            log.info(
                                                { field, value },
                                                '[ChatbotService#fixVersions] Coercing Gmail field to array',
                                            );
                                            let cleaned = value;
                                            if (
                                                cleaned.startsWith('[') &&
                                                cleaned.endsWith(']')
                                            ) {
                                                cleaned = cleaned
                                                    .substring(1, cleaned.length - 1)
                                                    .replace(/['"]/g, '')
                                                    .trim();
                                            }
                                            step.settings.input[field] = cleaned.includes(
                                                '{{',
                                            )
                                                ? [cleaned]
                                                : cleaned
                                                      .split(',')
                                                      .map((e: string) => e.trim())
                                                      .filter((e: string) => e.length > 0);
                                        }
                                    });
                                }

                                // Programmatically prune empty/null optional fields that cause UI validation errors
                                // We keep required fields even if empty (to show errors) but remove optional ones
                                const pieceActions: Record<string, any> =
                                    actualPiece.actions || {};
                                const pieceTriggers: Record<string, any> =
                                    actualPiece.triggers || {};
                                const actionMetadata =
                                    pieceActions[step.settings.actionName] ||
                                    pieceTriggers[step.settings.actionName];

                                if (actionMetadata && actionMetadata.props) {
                                    for (const [propKey, propValue] of Object.entries(
                                        step.settings.input,
                                    )) {
                                        const propMetadata =
                                            actionMetadata.props[propKey];
                                        const isOptional =
                                            propMetadata && !propMetadata.required;

                                        const isEmpty =
                                            isNil(propValue) ||
                                            propValue === '' ||
                                            (Array.isArray(propValue) &&
                                                propValue.length === 0) ||
                                            (typeof propValue === 'object' &&
                                                Object.keys(propValue).length === 0);

                                        if (isOptional && isEmpty) {
                                            log.info(
                                                { propKey, stepName: step.name },
                                                '[ChatbotService#fixVersions] Pruning empty optional field',
                                            );
                                            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                                            delete step.settings.input[propKey];
                                        }
                                    }
                                }

                                // Auto-fix for Google Sheets insert_row: values must be an object, not array
                                const isSheets = actualPiece.name === '@activepieces/piece-google-sheets'
                                if (isSheets && step.settings.actionName === 'insert_row' && Array.isArray(step.settings.input?.values)) {
                                    const headers: string[] = Array.isArray(step.settings.input.first_row_headers) ? step.settings.input.first_row_headers : []
                                    const valuesObj: Record<string, string> = {}
                                    ;(step.settings.input.values as string[]).forEach((v: string, i: number) => {
                                        valuesObj[headers[i] || `Column${i + 1}`] = v
                                    })
                                    log.info('[ChatbotService#fixVersions] Converted insert_row values from array to object')
                                    step.settings.input.values = valuesObj
                                }
                            }
                            else {
                                step.settings.pieceVersion = step.settings.pieceVersion || '0.0.1'
                            }
                        }
                        else {
                            step.settings.pieceVersion = step.settings.pieceVersion || '0.0.1'
                        }
                    }

                    // 3. Recursive processing of child actions
                    if (step.firstLoopAction) {
                        fixVersions(step.firstLoopAction, step, 'firstLoopAction')
                    }
                    if (step.onTrueNextAction) {
                        fixVersions(step.onTrueNextAction, step, 'onTrueNextAction')
                    }
                    if (step.onFalseNextAction) {
                        fixVersions(step.onFalseNextAction, step, 'onFalseNextAction')
                    }
                    if (step.nextAction) {
                        fixVersions(step.nextAction, step, 'nextAction')
                    }
                }
                fixVersions(flowJson.trigger)
            }

            return {
                reply,
                flowJson,
            }
        }
        catch (error: any) {
            const errorMessage = error?.response?.data ? JSON.stringify(error.response.data) : error.message
            log.error({ error: errorMessage }, 'All LLM providers failed')
            
            const firstPiece = piecesSummary.length > 0 ? piecesSummary[0] : null
            const triggerName = firstPiece && Object.keys(firstPiece.triggers || {})[0] ? Object.keys(firstPiece.triggers)[0] : 'default_trigger'

            const fallbackFlow = {
                displayName: 'Fallback Flow',
                trigger: {
                    name: 'trigger',
                    type: 'EMPTY',
                    displayName: 'Manual Trigger',
                    settings: {},
                    valid: true,
                    nextAction: {
                        name: 'step_1',
                        type: 'PIECE',
                        displayName: firstPiece?.displayName || 'First Step',
                        settings: {
                            pieceName: firstPiece?.name || 'google-sheets',
                            pieceVersion: firstPiece?.version || '0.0.1',
                            actionName: triggerName,
                            input: {},
                        },
                    },
                },
            }

            return {
                reply: `I'm sorry, I encountered an error while generating the workflow: ${errorMessage}. Here is a basic template to get you started.`,
                flowJson: fallbackFlow,
            }
        }
    },
}
