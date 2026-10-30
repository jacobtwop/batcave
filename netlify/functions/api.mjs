// Netlify function that serves /api/* for the batcave composer.
// All the logic lives in ../lib/core.mjs; this file only connects it to Netlify Blobs.
import { getStore } from '@netlify/blobs';
import { createHandler } from '../lib/core.mjs';

// Wrap a Blobs store in the small interface core.mjs expects.
function wrap(name) {
  const s = getStore({ name, consistency: 'strong' });
  return {
    get: (key) => s.get(key, { type: 'json' }),
    set: (key, value) => s.setJSON(key, value),
    delete: (key) => s.delete(key),
    list: async (prefix) => {
      const keys = [];
      for await (const page of s.list({ prefix, paginate: true })) {
        for (const b of page.blobs) keys.push(b.key);
      }
      return keys;
    },
  };
}

export default async (req, context) => {
  const handler = createHandler({
    data: wrap('composer'),
    auth: wrap('composer-auth'),
    env: (name) => Netlify.env.get(name),
  });
  return handler(req, context);
};

export const config = { path: '/api/*' };
