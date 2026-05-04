import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm'
import { SCHEMA_SQL, SEED_SQL } from './schema'

let db: Database | null = null

async function initDB(): Promise<Database> {
  if (db) return db

  const s3 = await sqlite3InitModule({ print: console.log, printErr: console.error })

  // SAH pool VFS: persistent, no SharedArrayBuffer/COOP/COEP required
  try {
    const pool = await s3.installOpfsSAHPoolVfs({ clearOnInit: false })
    db = new pool.OpfsSAHPoolDb('/lastglance.db')
  } catch {
    // Fall back to regular OPFS VFS (requires SharedArrayBuffer + COOP/COEP headers)
    if (s3.oo1.OpfsDb) {
      try {
        db = new s3.oo1.OpfsDb('/lastglance.db')
      } catch {
        db = null
      }
    }
    if (!db) {
      db = new s3.oo1.DB(':memory:', 'ct')
      console.warn('OPFS not available — using in-memory SQLite (data will not persist across reloads)')
    }
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
