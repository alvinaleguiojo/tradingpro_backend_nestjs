import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
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

    // Swagger documentation
    const config = new DocumentBuilder()
      .setTitle('TradingPro Auto Trading API')
      .setDescription('Auto Trading Backend with MT5, ICT Strategy, and OpenAI Analysis')
      .setVersion('1.0')
      .addTag('trading')
      .addTag('analysis')
      .addTag('mt5')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api', app, document);

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
