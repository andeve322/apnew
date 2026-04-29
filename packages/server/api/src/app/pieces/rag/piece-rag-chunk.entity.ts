import { EntitySchema } from 'typeorm'
import { BaseColumnSchemaPart } from '../../database/database-common'

type PieceRagChunkSchema = {
    id: string
    created: string
    updated: string
    pieceName: string
    pieceVersion: string
    content: string
    chunkIndex: number
    embedding: string | null
    metadata: object
}

export const PieceRagChunkEntity = new EntitySchema<PieceRagChunkSchema>({
    name: 'piece_rag_chunk',
    columns: {
        ...BaseColumnSchemaPart,
        pieceName: {
            type: String,
            nullable: false,
        },
        pieceVersion: {
            type: String,
            nullable: false,
        },
        content: {
            type: 'text',
            nullable: false,
        },
        chunkIndex: {
            type: Number,
            nullable: false,
        },
        embedding: {
            type: 'vector',
            length: '768',
            nullable: true,
        },
        metadata: {
            type: 'jsonb',
            nullable: true,
        },
    },
    indices: [
        {
            name: 'idx_piece_rag_piece_name_version',
            columns: ['pieceName', 'pieceVersion'],
        },
    ],
})
