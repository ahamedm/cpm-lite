import {
  OperationNodeTransformer,
  PrimitiveValueListNode,
  ValueNode,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from 'kysely';

/**
 * Kysely's DuckDB dialect passes JavaScript Date objects to the DuckDB node API
 * as ANY, which cannot be bound. Convert Dates to ISO strings in the query AST.
 */
class DateTransformer extends OperationNodeTransformer {
  protected override transformValue(node: ValueNode): ValueNode {
    if (node.value instanceof Date) {
      return ValueNode.create(node.value.toISOString());
    }
    return super.transformValue(node);
  }

  protected override transformPrimitiveValueList(node: PrimitiveValueListNode): PrimitiveValueListNode {
    if (node.values.some((value) => value instanceof Date)) {
      return PrimitiveValueListNode.create(
        node.values.map((value) => (value instanceof Date ? value.toISOString() : value))
      );
    }
    return super.transformPrimitiveValueList(node);
  }
}

export class DateToIsoPlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return new DateTransformer().transformNode(args.node);
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const rows = args.result.rows.map((row) => {
      const converted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        converted[key] = typeof value === 'bigint' ? Number(value) : value;
      }
      return converted;
    });
    return Promise.resolve({ ...args.result, rows });
  }
}
