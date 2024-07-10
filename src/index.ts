import opentelemetry from "@opentelemetry/api";
import { readFile } from "fs/promises";
import { resolve } from "path";
import {
  BadGateway,
  BadRequest,
  CapabilitiesResponse,
  CollectionInfo,
  ComparisonTarget,
  ComparisonValue,
  Connector,
  ConnectorError,
  ExplainResponse,
  Expression,
  ForeignKeyConstraint,
  InternalServerError,
  MutationRequest,
  MutationResponse,
  NotSupported,
  ObjectField,
  ObjectType,
  OrderByElement,
  Query,
  QueryRequest,
  QueryResponse,
  Relationship,
  RowFieldValue,
  ScalarType,
  SchemaResponse,
  start,
} from "@hasura/ndc-sdk-typescript";
import { withActiveSpan } from "@hasura/ndc-sdk-typescript/instrumentation";
import { Counter, Registry } from "prom-client";
import pg from "pg";

type Configuration = {
  risingwave: RisingWaveConfiguration;
  tables: TableConfiguration[];
};

type RisingWaveConfiguration = {
  user: string;
  database: string;
  host: string;
  port: number;
  password: string;
};

type TableConfiguration = {
  tableName: string;
  columns: { [k: string]: Column };
};

type Column = {};

type State = {
  db: pg.Pool;
};

async function parseConfiguration(
  configurationDir: string
): Promise<Configuration> {
  const configuration_file = resolve(configurationDir, "configuration.json");
  const configuration_data = await readFile(configuration_file);
  return JSON.parse(configuration_data.toString());
}

async function tryInitState(
  configuration: Configuration,
  registry: Registry
): Promise<State> {
  const db = new pg.Pool({
    user: configuration.risingwave.user,
    password: configuration.risingwave.password,
    database: configuration.risingwave.database,
    host: configuration.risingwave.host,
    port: configuration.risingwave.port,
  });

  return { db };
}

function getCapabilities(configuration: Configuration): CapabilitiesResponse {
  return {
    version: "0.1.5",
    capabilities: {
      query: {},
      mutation: {},
    },
  };
}

async function getSchema(
  configuration: Configuration
): Promise<SchemaResponse> {
  let collections: CollectionInfo[] = configuration.tables.map((table) => {
    return {
      arguments: {},
      name: table.tableName,
      deletable: false,
      foreign_keys: {},
      uniqueness_constraints: {},
      type: table.tableName,
    };
  });

  let scalar_types: { [k: string]: ScalarType } = {
    any: {
      aggregate_functions: {},
      comparison_operators: {
        eq: {
          type: "equal",
        },
      },
    },
  };

  let object_types: { [k: string]: ObjectType } = {};

  for (const table of configuration.tables) {
    let fields: { [k: string]: ObjectField } = {};

    for (const columnName in table.columns) {
      fields[columnName] = {
        type: {
          type: "named",
          name: "any",
        },
      };
    }

    object_types[table.tableName] = {
      fields,
    };
  }

  return {
    functions: [],
    procedures: [],
    collections,
    object_types,
    scalar_types,
  };
}

async function query(
  configuration: Configuration,
  state: State,
  request: QueryRequest
): Promise<QueryResponse> {
  const rows =
    request.query.fields &&
    (await fetch_rows(state, request.query, request.collection));

  return [{ rows }];
}

async function fetch_rows(
  state: State,
  query: Query,
  collection: string
): Promise<
  {
    [k: string]: RowFieldValue;
  }[]
> {
  const fields = [];

  for (const fieldName in query.fields) {
    if (Object.prototype.hasOwnProperty.call(query.fields, fieldName)) {
      const field = query.fields[fieldName];
      switch (field.type) {
        case "column":
          fields.push(`${field.column} AS ${fieldName}`);
          break;
        case "relationship":
          throw new Error("Relationships are not supported");
      }
    }
  }

  const order_by_clause =
    query.order_by == null
      ? ""
      : `ORDER BY ${visit_order_by_elements(query.order_by.elements)}`;

  const limit_clause = query.limit == null ? "" : `LIMIT ${query.limit}`;
  const offset_clause = query.offset == null ? "" : `OFFSET ${query.offset}`;

  const parameters: any[] = [];

  const where_clause =
    query.predicate == null
      ? ""
      : `WHERE ${visit_expression(parameters, query.predicate)}`;

  const sql = `SELECT ${
    fields.length ? fields.join(", ") : "1 AS __empty"
  } FROM ${collection} ${where_clause} ${limit_clause} ${offset_clause}`;

  console.log(JSON.stringify({ sql, parameters }, null, 2));

  const rows = (await state.db.query({ text: sql, values: parameters })).rows;
  return rows.map((row) => {
    delete row.__empty;
    return row;
  });
}

function visit_expression(parameters: any[], expr: Expression): string {
  switch (expr.type) {
    case "and":
      if (expr.expressions.length > 0) {
        return expr.expressions
          .map((e) => visit_expression_with_parens(parameters, e))
          .join(" AND ");
      } else {
        return "TRUE";
      }
    case "or":
      if (expr.expressions.length > 0) {
        return expr.expressions
          .map((e) => visit_expression_with_parens(parameters, e))
          .join(" OR ");
      } else {
        return "FALSE";
      }
    case "not":
      return `NOT ${visit_expression_with_parens(parameters, expr.expression)}`;
    case "unary_comparison_operator":
      switch (expr.operator) {
        case "is_null":
          return `${visit_comparison_target(expr.column)} IS NULL`;
        default:
          throw new BadRequest("Unknown comparison operator");
      }
    case "binary_comparison_operator":
      switch (expr.operator) {
        case "eq":
          return `${visit_comparison_target(
            expr.column
          )} = ${visit_comparison_value(parameters, expr.value)}`;
        case "like":
          return `${visit_comparison_target(
            expr.column
          )} LIKE ${visit_comparison_value(parameters, expr.value)}`;
        default:
          throw new BadRequest("Unknown comparison operator");
      }
    case "exists":
      throw new NotSupported("exists is not supported");
    default:
      throw new BadRequest("Unknown expression type");
  }
}

function visit_expression_with_parens(
  parameters: any[],
  expr: Expression
): string {
  return `(${visit_expression(parameters, expr)})`;
}

function visit_comparison_target(target: ComparisonTarget) {
  switch (target.type) {
    case "column":
      if (target.path.length > 0) {
        throw new NotSupported("Relationships are not supported");
      }
      return target.name;
    case "root_collection_column":
      throw new NotSupported("Relationships are not supported");
  }
}

function visit_comparison_value(parameters: any[], target: ComparisonValue) {
  switch (target.type) {
    case "scalar":
      parameters.push(target.value);
      return "$" + parameters.length;
    case "column":
      throw new NotSupported("column_comparisons are not supported");
    case "variable":
      throw new NotSupported("Variables are not supported");
  }
}

function visit_order_by_elements(elements: OrderByElement[]): String {
  if (elements.length > 0) {
    return elements.map(visit_order_by_element).join(", ");
  } else {
    return "1";
  }
}

function visit_order_by_element(element: OrderByElement): String {
  const direction = element.order_direction === "asc" ? "ASC" : "DESC";

  switch (element.target.type) {
    case "column":
      if (element.target.path.length > 0) {
        throw new NotSupported("Relationships are not supported");
      }
      return `${element.target.name} ${direction}`;
    default:
      throw new NotSupported("order_by_aggregate are not supported");
  }
}

async function fetchMetrics(
  configuration: Configuration,
  state: State
): Promise<undefined> {
  throw new Error("Function not implemented.");
}

async function healthCheck(
  configuration: Configuration,
  state: State
): Promise<undefined> {
  throw new Error("Function not implemented.");
}

async function queryExplain(
  configuration: Configuration,
  state: State,
  request: QueryRequest
): Promise<ExplainResponse> {
  throw new Error("Function not implemented.");
}

async function mutationExplain(
  configuration: Configuration,
  state: State,
  request: MutationRequest
): Promise<ExplainResponse> {
  throw new Error("Function not implemented.");
}

async function mutation(
  configuration: Configuration,
  state: State,
  request: MutationRequest
): Promise<MutationResponse> {
  throw new Error("Function not implemented.");
}

const connector: Connector<Configuration, State> = {
  parseConfiguration,
  tryInitState,
  getCapabilities,
  getSchema,
  query,
  fetchMetrics,
  healthCheck,
  queryExplain,
  mutationExplain,
  mutation,
};

start(connector);
