import mongoose from "mongoose";

/** Cached Mongoose connection for serverless/hot-reload environments.
 *  Without caching, every request (or HMR reload) opens a new pool and
 *  exhausts Atlas connection limits. */
const MONGODB_URI = process.env.MONGODB_URI;

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var _mongoose: MongooseCache | undefined;
}

const cached: MongooseCache = global._mongoose ?? { conn: null, promise: null };
global._mongoose = cached;

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is not set — add it to .env.local");
  }
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    // Atlas M0 free tier caps total connections at 500; the driver default
    // pool is 100 per process. Cap tight so many apps can share one cluster.
    cached.promise = mongoose.connect(MONGODB_URI, {
      bufferCommands: false,
      maxPoolSize: 5,
      maxIdleTimeMS: 30000,
    });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}
