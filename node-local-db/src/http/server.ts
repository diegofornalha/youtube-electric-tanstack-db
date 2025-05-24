import { fastifyCors } from "@fastify/cors";
import { fastifyCompress } from "@fastify/compress";
import { fastifyEtag } from "@fastify/etag";
import { fastifyHelmet } from "@fastify/helmet";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod'
import { fastify } from "fastify";
import { z } from "zod";
import { db } from "../db/client.ts";
import { schema } from "../db/schema/index.ts";
import { eq, desc, sql } from "drizzle-orm";

const app = fastify({ 
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
  },
}).withTypeProvider<ZodTypeProvider>()

app.setSerializerCompiler(serializerCompiler)
app.setValidatorCompiler(validatorCompiler)

await app.register(fastifyHelmet)
await app.register(fastifyCompress, { global: true })
await app.register(fastifyEtag)
await app.register(fastifyCors, {
  origin: process.env.NODE_ENV === 'production' ? 'https://yourdomain.com' : true,
  credentials: true,
})

const issuesCache = new Map<string, { data: any; timestamp: number }>()
const CACHE_TTL = 60 * 1000 // 1 minute

app.post('/issues', {
  schema: {
    body: z.object({
      title: z.string().min(1).max(255),
      description: z.string().optional(),
      userId: z.coerce.number().int().positive(),
    }),
    response: {
      201: z.object({
        id: z.number(),
        title: z.string(),
        userId: z.number(),
        createdAt: z.date(),
      }),
    },
  },
}, async (request, reply) => {
  const { title, description, userId } = request.body

  const [newIssue] = await db.insert(schema.issues).values({
    title,
    description,
    userId,
  }).returning()

  issuesCache.clear()

  return reply.status(201).send(newIssue)
})

app.get('/issues', {
  schema: {
    querystring: z.object({
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(20),
      userId: z.coerce.number().int().positive().optional(),
    }),
    response: {
      200: z.object({
        data: z.array(z.object({
          id: z.number(),
          title: z.string(),
          description: z.string().nullable(),
          userId: z.number(),
          createdAt: z.date(),
        })),
        pagination: z.object({
          page: z.number(),
          limit: z.number(),
          total: z.number(),
          totalPages: z.number(),
        }),
      }),
    },
  },
}, async (request, reply) => {
  const { page, limit, userId } = request.query
  const offset = (page - 1) * limit
  
  const cacheKey = `issues:${page}:${limit}:${userId || 'all'}`
  const cached = issuesCache.get(cacheKey)
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    reply.header('X-Cache', 'HIT')
    return cached.data
  }

  const conditions = userId ? eq(schema.issues.userId, userId) : undefined
  
  const [issues, [{ count }]] = await Promise.all([
    db.select()
      .from(schema.issues)
      .where(conditions)
      .orderBy(desc(schema.issues.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` })
      .from(schema.issues)
      .where(conditions),
  ])

  const result = {
    data: issues,
    pagination: {
      page,
      limit,
      total: count,
      totalPages: Math.ceil(count / limit),
    },
  }

  issuesCache.set(cacheKey, { data: result, timestamp: Date.now() })
  reply.header('X-Cache', 'MISS')
  
  return result
})

app.get('/issues/:id', {
  schema: {
    params: z.object({
      id: z.coerce.number().int().positive(),
    }),
    response: {
      200: z.object({
        id: z.number(),
        title: z.string(),
        description: z.string().nullable(),
        userId: z.number(),
        createdAt: z.date(),
        user: z.object({
          id: z.number(),
          name: z.string(),
        }),
      }),
      404: z.object({
        error: z.string(),
      }),
    },
  },
}, async (request, reply) => {
  const { id } = request.params

  const result = await db
    .select({
      id: schema.issues.id,
      title: schema.issues.title,
      description: schema.issues.description,
      userId: schema.issues.userId,
      createdAt: schema.issues.createdAt,
      user: {
        id: schema.users.id,
        name: schema.users.name,
      },
    })
    .from(schema.issues)
    .innerJoin(schema.users, eq(schema.issues.userId, schema.users.id))
    .where(eq(schema.issues.id, id))
    .limit(1)

  if (result.length === 0) {
    return reply.status(404).send({ error: 'Issue not found' })
  }

  return result[0]
})

app.get('/health', {
  schema: {
    response: {
      200: z.object({
        status: z.literal('ok'),
        timestamp: z.string(),
        uptime: z.number(),
      }),
    },
  },
}, async (request, reply) => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }
})

app.setErrorHandler((error, request, reply) => {
  app.log.error(error)
  
  if (error.validation) {
    return reply.status(400).send({
      error: 'Validation Error',
      message: 'Invalid request data',
      details: error.validation,
    })
  }

  if (error.statusCode === 429) {
    return reply.status(429).send({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please try again later.',
    })
  }

  return reply.status(500).send({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred',
  })
})

const start = async () => {
  try {
    await app.listen({ port: 3333, host: '0.0.0.0' })
    app.log.info('🚀 HTTP server running on http://localhost:3333')
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()