import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Express, Request, Response } from 'express';
const express = require('express');

const server: Express = express();

let cachedApp: any = null;

async function bootstrap(): Promise<any> {
  if (!cachedApp) {
    const app = await NestFactory.create(
      AppModule,
      new ExpressAdapter(server),
      { logger: ['error', 'warn'] },
    );

    app.enableCors({
      origin: '*',
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
      credentials: true,
    });
    
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );

    await app.init();
    cachedApp = app;
  }
  return cachedApp;
}

// Ensure NestJS is bootstrapped before handling requests
const bootstrapPromise = bootstrap();

export default async (req: Request, res: Response) => {
  await bootstrapPromise;
  server(req, res);
};
