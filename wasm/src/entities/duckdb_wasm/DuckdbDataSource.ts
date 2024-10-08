import {
  TabularDataSource,
  ITabularExecuteOpts,
  SqlTranslator,
  ITableInfo,
  IFieldInfo,
  ICalculatedColumn,
  ITabularResultSet,
  IFetchQuery
} from '@ducklab/core';
import { initDuckdb } from "./init";
import { DuckDBDataProtocol, AsyncDuckDBConnection, AsyncDuckDB } from '@duckdb/duckdb-wasm';
import * as arrow from 'apache-arrow';
import type { FileSystemReference } from '@/entities/FileSystemReference';

export class DuckdbDataSource extends TabularDataSource {
  private _tr: SqlTranslator;
  public readonly opts: Required<DuckOptions>;
  private _conn: AsyncDuckDBConnection | null = null;
  private db: AsyncDuckDB | null = null;

  constructor(name: string, duckOpts: DuckOptions) {
    super(name);
    console.log("Translator: ", SqlTranslator, this);
    this._tr = new SqlTranslator();
    this.opts = {
      supportedTypes: [".csv", ".parquet"],
      batchSize: 10000,
      previewLimit: 1000,
      rawLimit: -1,
      extensions: [],
      ...duckOpts,
    };
  }

  public async _init() {
    console.log("Init duckdb");
    const db = await initDuckdb();
    console.log("Init duckdb: ", db);
    return db;
  }

  public async test(): Promise<void> {
    if (!this._conn) {
      await this.connect();
      return;
    }
    await this.queryNative('SELECT 1');
  }

  public async connect(): Promise<void> {
    if (!this.db) this.db = await this._init();
    this._conn = await this.db.connect();
    if (!this._conn) throw Error("duckdb: Failed to connect");
    await this.test();
    await this.loadExtensions();
  }

  private async loadExtensions(): Promise<void> {
    for (const ext of this.opts.extensions ?? []) {
      const res = await this.queryNative(`INSTALL ${ext}\nLOAD ${ext}`);
      console.log(`Loaded: ${ext}`, res);
    }
  }

  private async *executeNativeBatch(query: string): AsyncGenerator<ITabularResultSet> {
    if (!this._conn) await this.connect();
    if (!this._conn) return;
    console.log("Raw query: ", query);
    const res = await this._conn.query(query);
    console.log("Raw result: ", res);
    // let count = 0;
    for await (const batch of res.batches) {
      const res = this.transformBatch(batch);
      // if (count + res.values.length > this.opts.batchSize) {
      //   console.log("Slicing: ", count, this.opts.batchSize, batch, res);
      //   res.values = res.values.slice(0, this.opts.batchSize - count);
      // }
      // count = count + res.values.length;
      yield res;
    }
  }

  public async importFile(file: FileSystemReference) {
    if (!this.db) throw Error("db is not initialized correctly");
    if (file.type === "folder") {
      for (const fil of file.children) {
        await this.importFile(fil);
      }
      return;
    }
    else if (!file.handle) return;

    // return if file type is not supported
    else if (this.opts.supportedTypes.filter(t => file.name.toLowerCase().endsWith(t)).length === 0) {
      console.log(`Skipping file: ${file.path}`);
    }
    else {
      await this.db.registerFileHandle(file.path, await file.handle.getFile(), DuckDBDataProtocol.BROWSER_FILEREADER, true);
    }
  }

  public async dropFile(file: FileSystemReference) {
    if (!this.db) throw Error("db is not initialized correctly");
    await this.db.dropFile(file.path);
  }

  public async reset() {
    if (!this.db) return;
    await this.db.dropFiles();
  }

  public async listFiles() {
    if (!this.db) throw Error("db is not initialized correctly");
    return await this.db.globFiles('*');
  }

  public async importRemoteFile(url: string) {
    if (!this.db) throw Error("db is not initialized correctly");
    await this.db.registerFileURL(url, url, DuckDBDataProtocol.HTTP, false);
  }


  getJsonType(type: any) {
    if (arrow.DataType.isInt(type)) return "number";
    if (arrow.DataType.isFloat(type)) return "number";
    if (arrow.DataType.isDecimal(type)) return "number";
    if (arrow.DataType.isBool(type)) return "boolean";
    if (arrow.DataType.isDate(type)) return "datetime";
    return "string";
  }

  private transformBatch(batch: any) {
    const items: any[] = [];
    const columns: IFieldInfo[] = [];
    for (const col of batch.schema.fields) {
      columns.push({
        name: col.name,
        type: this.getJsonType(col.type),
      });
    }
    for (let i = 0; i < batch.numRows; i++) {
      items.push({ _index: i, ...batch.get(i).toJSON() });
    }
    return {
      columns: columns,
      values: items,
    };
  }

  private addLimit(rawQuery: string, limit: number, offset: number) {
    rawQuery = rawQuery.trim();
    if (rawQuery.endsWith(';')) {
      rawQuery = rawQuery.substring(0, rawQuery.length - 1);
    }
    return `select * from (${rawQuery}) offset ${offset} limit ${limit};`;
  }

  public async createView(name: string, query: IFetchQuery) {
    const sql = this._tr.translate(query);
    await this.queryNative(`CREATE OR REPLACE VIEW '${name}' AS (${sql})`);
  }

  public async queryNative(query: string, limit?: number) {
    let values: any[] = [];
    let columns: IFieldInfo[] = [];
    for await (const batch of this.executeNativeBatch(query)) {
      values = values.concat(batch.values);
      columns = batch.columns;
      if (limit != null && limit >= 0 && values.length >= limit) {
        values = values.slice(0, limit);
        break;
      }
    }
    return {
      columns,
      values
    };
  }

  public async query(params: ITabularExecuteOpts, limit?: number, offset?: number) {
    if (!offset) offset = 0;
    if (params.rawQuery != null) {
      return await this.queryNative(params.rawQuery, limit ?? this.opts.rawLimit);
    }
    if (!params.query) throw Error("Query must be provided");
    const sql = this._tr.translate(params.query, limit ?? this.opts.previewLimit, offset);
    console.log(sql);
    return await this.queryNative(sql);
  }

  public async getDatasets(): Promise<ITableInfo[]> {
    const results = await this.queryNative(`
        SELECT TABLE_SCHEMA as "schema",
        TABLE_NAME as "table",
        COLUMN_NAME as "column",
        COLUMN_DEFAULT as "default",
        DATA_TYPE as "type",
        CHARACTER_MAXIMUM_LENGTH as max_len
        from INFORMATION_SCHEMA.COLUMNS
        where TABLE_SCHEMA not in ('pg_catalog', 'temp');
        `);
    console.log(results);
    return this.createDatasets(results);
  }

  protected createDatasets(data: ITabularResultSet): ITableInfo[] {
    const infos: { [key: string]: ITableInfo; } = {};
    for (const col of data.values) {
      if (!(col.table in infos)) {
        infos[col.table] = {
          name: col.table,
          type: 'duckdb',
          namespace: [col.schema],
          schema: [] as IFieldInfo[],
          query: {
            fields: [{ expression: "*" } as ICalculatedColumn],
            from: { name: col.name, namespace: col.schema }
          },
        };
      }
      infos[col.table].schema.push({
        name: col.column,
        type: col.type,
        default: col.default,
        maxSize: col.max_len,
      });
    }
    return Object.values(infos);
  }
}

export interface DuckOptions {
  batchSize?: number;
  extensions?: string[];
  supportedTypes?: string[];
  previewLimit?: number;
  rawLimit?: number;
}
