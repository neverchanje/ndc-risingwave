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
  try {
    const configuration_file = resolve(configurationDir, "configuration.json");
    const configuration_data = await readFile(configuration_file);
    return JSON.parse(configuration_data.toString());
  } catch (x) {
    throw new ConnectorError(500, "Failed to parse configuration: ", {
      exception: x,
    });
  }
}

async function tryInitState(
  configuration: Configuration,
  registry: Registry
): Promise<State> {
  try {
    const db = new pg.Pool({
      user: configuration.risingwave.user,
      password: configuration.risingwave.password,
      database: configuration.risingwave.database,
      host: configuration.risingwave.host,
      port: configuration.risingwave.port,
    });

    return { db };
  } catch (x) {
    throw new ConnectorError(500, "Failed to instantiate states: ", {
      exception: x,
    });
  }
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
  throw new Error("Function not implemented.");
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
