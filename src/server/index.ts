import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createServer, getServerPort } from '@devvit/web/server';
import { commentCapRoutes } from './commentCap.js';

const app = new Hono();

app.route('/internal', commentCapRoutes);

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
