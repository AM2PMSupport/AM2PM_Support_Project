/**
 * POST|GET /api/graphql — GraphQL API (API.md §6). Same auth as REST v1:
 * session cookie or `Authorization: Bearer am2pm_…`. Schema + resolvers live
 * in lib/graphql/schema.ts. GraphiQL (browser IDE) is served on GET.
 */
import { createSchema, createYoga, type Plugin, type YogaInitialContext } from "graphql-yoga";
import { apiContext } from "@/lib/api/context";
import { depthLimit, resolvers, toGraphQLError, typeDefs } from "@/lib/graphql/schema";
import { log } from "@/lib/log";

const depthLimitPlugin: Plugin = { onValidate: ({ addValidationRule }) => addValidationRule(depthLimit) };

const yoga = createYoga<{ request: Request }, { api: Awaited<ReturnType<typeof apiContext>> }>({
  schema: createSchema({ typeDefs, resolvers }),
  graphqlEndpoint: "/api/graphql",
  fetchAPI: { Response },
  // Resolve who is calling once per request; unauthenticated → 401 error for every operation.
  context: async ({ request }: YogaInitialContext) => ({ api: await apiContext(request) }),
  plugins: [depthLimitPlugin],
  maskedErrors: {
    maskError: (err) => {
      const mapped = toGraphQLError(err);
      if (mapped.extensions.code === "internal") log.error("graphql error", { err });
      return mapped;
    },
  },
  batching: false,
  landingPage: false,
});

const handler = (req: Request) => yoga.handleRequest(req, { request: req });
export { handler as GET, handler as POST, handler as OPTIONS };
