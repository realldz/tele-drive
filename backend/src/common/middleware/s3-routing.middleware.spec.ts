import express from 'express';
import request from 'supertest';
import { createS3RoutingMiddleware } from './s3-routing.middleware';

describe('S3 host routing', () => {
  const app = express();
  app.use(createS3RoutingMiddleware('s3.example.com'));
  app.get('/s3', (req, res) =>
    res.json({ op: 'buckets', signed: req.originalUrl }),
  );
  app.get('/s3/:bucket', (req, res) =>
    res.json({
      op: 'objects',
      bucket: req.params.bucket,
      signed: req.originalUrl,
    }),
  );
  app.post('/s3/:bucket/*key', (req, res) =>
    res.json({ bucket: req.params.bucket, signed: req.originalUrl }),
  );

  it.each(['s3', 'photos', 'api'])(
    'lists the actual %s bucket',
    async (bucket) => {
      const path = `/${bucket}/?list-type=2&prefix=a%2Bb`;
      const res = await request(app).get(path).set('Host', 's3.example.com');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ op: 'objects', bucket, signed: path });
    },
  );
  it('lists buckets at the endpoint root', async () => {
    const res = await request(app).get('/').set('Host', 's3.example.com');
    expect(res.body as unknown).toEqual({ op: 'buckets', signed: '/' });
  });
  it('routes multipart on s3 without changing the signed URI', async () => {
    const path = '/s3/a%20b?uploads';
    const res = await request(app).post(path).set('Host', 's3.example.com');
    expect(res.body).toEqual({ bucket: 's3', signed: path });
  });
  it('preserves the direct internal API alias on other hosts', async () => {
    const res = await request(app).get('/api/s3?x=1').set('Host', 'localhost');
    expect(res.body).toEqual({ op: 'buckets', signed: '/api/s3?x=1' });
  });
  it('does not treat an unrelated host as an S3 endpoint', async () => {
    expect(
      (await request(app).get('/photos').set('Host', 'app.example.com')).status,
    ).toBe(404);
  });
});
