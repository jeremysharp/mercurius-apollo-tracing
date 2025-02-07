import { FastifyPluginCallback } from 'fastify'
import fp from 'fastify-plugin'
import 'mercurius' // needed for types
import { Dispatcher } from 'undici'

import { ApolloTraceBuilder } from './ApolloTraceBuilder'
import {
  addTraceToReportAndFinishTiming,
  flushTraces,
  getTraceSize,
  prepareReportWithHeaders
} from './flushTraces'
import { hookIntoSchemaResolvers } from './hookIntoSchemaResolvers'
import { sendReport } from './sendReport'

const DEFAULT_MAX_REPORT_SIZE = 4 * 1024 * 1024
const DEFAULT_MAX_REPORT_TIME = 10 * 1000

export type MercuriusApolloTracingOptions = {
  endpointUrl?: string
  graphRef: string
  apiKey: string
  /**
   * useful for lambda-like environment where the whole process exits
   */
  sendReportsImmediately?: true
  /**
   * flush interval in milliseconds
   */
  reportIntervalMs?: number
  /**
   * max report size in bytes
   */
  maxUncompressedReportSize?: number
}

declare module 'fastify' {
  interface FastifyInstance {
    flushApolloTracing: () => Promise<Dispatcher.ResponseData | undefined>
  }

  interface FastifyRegister {
    (
      plugin: FastifyPluginCallback<MercuriusApolloTracingOptions>,
      opts: MercuriusApolloTracingOptions
    ): FastifyInstance
  }
}

declare module 'mercurius' {
  interface MercuriusContext {
    __traceBuilder: ApolloTraceBuilder
  }
}

const traceBuilders: ApolloTraceBuilder[] = []

export default fp(
  async function (app, opts: MercuriusApolloTracingOptions) {
    let firstTraceSize: number
    let traceBuildersTimer: number = Date.now()

    if (!opts.apiKey) {
      throw new Error('an Apollo Studio API key is required')
    }

    app.log.debug('registering mercuriusApolloTracing')
    hookIntoSchemaResolvers(app.graphql.schema)

    app.graphql.addHook('preExecution', async (_schema, document, context) => {
      const traceBuilder: ApolloTraceBuilder = new ApolloTraceBuilder(
        document,
        {}
      )
      traceBuilder.startTiming()

      context.__traceBuilder = traceBuilder
      return { document }
    })

    app.graphql.addHook('onResolution', async (execution, context: any) => {
      const traceBuilder: ApolloTraceBuilder = context.__traceBuilder

      if (context.errors) {
        // The below reports errors if they are returned from preExecution hook
        traceBuilder.didEncounterErrors(context.errors)
      } else if (execution.errors) {
        // this reports errors from execution
        traceBuilder.didEncounterErrors(execution.errors)
      }

      traceBuilder.stopTiming()

      const schema = app.graphql.schema
      if (opts.sendReportsImmediately) {
        setImmediate(() => {
          const report = prepareReportWithHeaders(schema, opts)
          addTraceToReportAndFinishTiming(traceBuilder, report)

          sendReport(report, opts, app)
        })
      } else {
        traceBuilders.push(traceBuilder)

        if (!firstTraceSize && traceBuilders.length === 1) {
          // use size of first trace to estimate report size
          firstTraceSize = getTraceSize(traceBuilder)
        }

        const reachedMaxSize: boolean =
          firstTraceSize * traceBuilders.length >=
          (opts.maxUncompressedReportSize || DEFAULT_MAX_REPORT_SIZE)

        const reachedMaxTime: boolean =
          Date.now() >=
          traceBuildersTimer +
            (opts.reportIntervalMs || DEFAULT_MAX_REPORT_TIME)

        if (reachedMaxSize || reachedMaxTime) {
          const report = prepareReportWithHeaders(schema, opts)
          addTraceToReportAndFinishTiming(traceBuilder, report)

          await sendReport(report, opts, app)
          flushTraces(app, traceBuilders, opts)
          traceBuildersTimer = Date.now()
        }
      }
    })

    if (!opts.sendReportsImmediately) {
      flushTraces(app, traceBuilders, opts)
    }
  },
  {
    fastify: '3.x',
    name: 'mercuriusApolloTracing',
    dependencies: ['mercurius']
  }
)
