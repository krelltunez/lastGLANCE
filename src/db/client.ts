import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm'
import { SCHEMA_SQL, SEED_SQL } from './schema'

let db: Database | null = null

async function initDB(): Promise<Database> {
  if (db) return db

  const s3 = await sqlite3InitModule({ print: console.log, printErr: console.error })

  if (s3.capi.sqlite3_vfs_find('opfs')) {
    const oo = s3.oo1 as typeof s3.oo1 & { OpfsDb: new (path: string) => Database }
    db = new oo.OpfsDb('/lastglance.db')
  } else {
    db = new s3.oo1.DB(':memory:', 'ct')
    console.warn('OPFS not available — using in-memory SQLite (data will not persist)')
  }

  db.exec(SCHEMA_SQL)

  const hasCategories = (db.selectValue('SELECT COUNT(*) FROM categories') as number) > 0
  if (!hasCategories) db.exec(SEED_SQL)

  return db
}

let initPromise: Promise<Database> | null = null

export function getDB(): Promise<Database> {
  if (!initPromise) initPromise = initDB()
  return initPromise
}

export type { Database }
