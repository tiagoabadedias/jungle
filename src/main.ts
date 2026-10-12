import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';
import { configureApp } from './configure-app.ts';
import { APP_CONFIG, type AppConfig } from './shared/infrastructure/config/app-config.ts';
import { errorMessage } from './shared/application/error-message.ts';

async function bootstrap(): Promise<void> {
  // bufferLogs: os logs do boot saem já pelo pino (JSON), depois que o logger é instalado.
  const app = configureApp(await NestFactory.create(AppModule, { bufferLogs: true }));
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port);
  new Logger('Lifecycle').log({ msg: 'listening', port: config.port, pid: process.pid });
}

try {
  await bootstrap();
} catch (error) {
  // Falha no boot (config inválida, banco/fila inacessível): descarrega os logs em buffer.
  Logger.flush();
  console.error(JSON.stringify({ level: 'fatal', msg: 'bootstrap failed', error: errorMessage(error) }));
  process.exit(1);
}
