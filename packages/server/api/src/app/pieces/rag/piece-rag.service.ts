import {
  PieceMetadataModel,
  apId,
  isNil,
  spreadIfDefined,
} from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { In, IsNull, Not } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { databaseConnection } from '../../database/database-connection'
import { PieceRagChunkEntity } from './piece-rag-chunk.entity'

const CHUNK_SIZE_CHARS = 2000
const CHUNK_OVERLAP_CHARS = 200

const pieceRagChunkRepo = repoFactory(PieceRagChunkEntity)

function chunkText(text: string): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE_CHARS, text.length)
    chunks.push(text.slice(start, end))
    if (end >= text.length) break
    start = end - CHUNK_OVERLAP_CHARS
  }
  return chunks
}

function extractPieceText(piece: PieceMetadataModel): string {
  const parts: string[] = []

  parts.push(`Piece: ${piece.displayName}`)
  parts.push(`Name: ${piece.name}`)
  parts.push(`Version: ${piece.version}`)
  if (piece.description) {
    parts.push(`Description: ${piece.description}`)
  }
  if (piece.categories && piece.categories.length > 0) {
    parts.push(`Categories: ${piece.categories.join(', ')}`)
  }

  if (piece.actions) {
    for (const [actionName, action] of Object.entries(piece.actions)) {
      parts.push(`\nAction: ${action.displayName}`)
      parts.push(`Action Name: ${actionName}`)
      if (action.description) {
        parts.push(`Description: ${action.description}`)
      }
      if (action.props) {
        const propNames = Object.entries(action.props)
          .map(([propName, prop]: [string, { displayName?: string; description?: string; type: string }]) => {
            const display = prop.displayName ?? propName
            const desc = prop.description ? ` (${prop.description})` : ''
            return `${display} [${prop.type}]${desc}`
          })
          .join(', ')
        if (propNames) {
          parts.push(`Properties: ${propNames}`)
        }
      }
    }
  }

  if (piece.triggers) {
    for (const [triggerName, trigger] of Object.entries(piece.triggers)) {
      parts.push(`\nTrigger: ${trigger.displayName}`)
      parts.push(`Trigger Name: ${triggerName}`)
      if (trigger.description) {
        parts.push(`Description: ${trigger.description}`)
      }
      if (trigger.type) {
        parts.push(`Type: ${trigger.type}`)
      }
      if (trigger.props) {
        const propNames = Object.entries(trigger.props)
          .map(([propName, prop]: [string, { displayName?: string; description?: string; type: string }]) => {
            const display = prop.displayName ?? propName
            const desc = prop.description ? ` (${prop.description})` : ''
            return `${display} [${prop.type}]${desc}`
          })
          .join(', ')
        if (propNames) {
          parts.push(`Properties: ${propNames}`)
        }
      }
    }
  }

  return parts.join('\n')
}

export const pieceRagService = (log: FastifyBaseLogger) => ({
  async indexPiece(params: {
    piece: PieceMetadataModel
    embedFn: (texts: string[]) => Promise<number[][]>
  }): Promise<void> {
    const { piece, embedFn } = params

    const text = extractPieceText(piece)
    if (text.length === 0) {
      return
    }

    const textChunks = chunkText(text)
    if (textChunks.length === 0) {
      return
    }

    await pieceRagChunkRepo().delete({
      pieceName: piece.name,
      pieceVersion: piece.version,
    })

    const EMBED_BATCH_SIZE = 50
    const allChunks: {
      content: string
      embedding: number[]
      chunkIndex: number
      metadata: object
    }[] = []

    for (let i = 0; i < textChunks.length; i += EMBED_BATCH_SIZE) {
      const batch = textChunks.slice(i, i + EMBED_BATCH_SIZE)
      const embeddings = await embedFn(batch)

      if (embeddings.length !== batch.length) {
        throw new Error(
          `Embedding count mismatch: expected ${batch.length}, got ${embeddings.length}`,
        )
      }

      for (let j = 0; j < batch.length; j++) {
        allChunks.push({
          content: batch[j],
          embedding: embeddings[j],
          chunkIndex: i + j,
          metadata: {
            pieceName: piece.name,
            pieceVersion: piece.version,
            displayName: piece.displayName,
            chunkIndex: i + j,
            totalChunks: textChunks.length,
          },
        })
      }
    }

    const BATCH_SIZE = 100
    for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
      const batch = allChunks.slice(i, i + BATCH_SIZE)
      const entities = batch.map((chunk) => ({
        id: apId(),
        pieceName: piece.name,
        pieceVersion: piece.version,
        content: chunk.content,
        chunkIndex: chunk.chunkIndex,
        embedding: `[${chunk.embedding.join(',')}]`,
        metadata: chunk.metadata,
      }))
      await pieceRagChunkRepo().insert(entities)
    }

    log.info(
      { pieceName: piece.name, version: piece.version, chunks: allChunks.length },
      'Indexed piece for RAG',
    )
  },

  async searchSimilarPieces(params: {
    queryEmbedding: number[]
    limit?: number
    similarityThreshold?: number
  }): Promise<
    {
      pieceName: string
      pieceVersion: string
      content: string
      score: number
      metadata: object
    }[]
  > {
    const { queryEmbedding, limit = 20, similarityThreshold } = params

    const embeddingStr = `[${queryEmbedding.join(',')}]`

    const results = await databaseConnection().query(
      `SELECT DISTINCT ON (prc."pieceName") prc."pieceName", prc."pieceVersion", prc.content, prc.embedding <=> $1::vector AS distance, prc.metadata
       FROM piece_rag_chunk prc
       WHERE prc.embedding IS NOT NULL
       ORDER BY prc."pieceName", distance
       LIMIT $2`,
      [embeddingStr, limit],
    )

    return results
      .map((row: { pieceName: string; pieceVersion: string; content: string; distance: number; metadata: object }) => ({
        pieceName: row.pieceName,
        pieceVersion: row.pieceVersion,
        content: row.content,
        score: Math.max(0, 1 - row.distance),
        metadata: row.metadata,
      }))
      .filter((row) => similarityThreshold === undefined || row.score >= similarityThreshold)
  },

  async removePieceIndex(params: { pieceName: string; pieceVersion?: string }): Promise<void> {
    const { pieceName, pieceVersion } = params
    const where: Record<string, unknown> = { pieceName }
    if (!isNil(pieceVersion)) {
      where.pieceVersion = pieceVersion
    }
    await pieceRagChunkRepo().delete(where)
  },

  async indexAllPieces(params: {
    pieces: PieceMetadataModel[]
    embedFn: (texts: string[]) => Promise<number[][]>
  }): Promise<void> {
    const { pieces, embedFn } = params
    for (const piece of pieces) {
      try {
        await this.indexPiece({ piece, embedFn })
      } catch (error) {
        log.error({ error, pieceName: piece.name }, 'Failed to index piece for RAG')
      }
    }
  },

  async getIndexedPieces(): Promise<{ pieceName: string; pieceVersion: string }[]> {
    const results = await pieceRagChunkRepo().find({
      select: ['pieceName', 'pieceVersion'],
      where: { pieceName: Not(IsNull()) },
    })

    const unique = new Map<string, string>()
    for (const result of results) {
      const key = `${result.pieceName}-${result.pieceVersion}`
      if (!unique.has(key)) {
        unique.set(key, result.pieceName)
      }
    }

    return Array.from(unique.entries()).map(([key, name]) => {
      const [pieceName, pieceVersion] = key.split('-')
      return { pieceName, pieceVersion }
    })
  },
})
