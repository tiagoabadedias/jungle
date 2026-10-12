import { Global, Module } from '@nestjs/common';
import { CLOCK } from '../application/ports/clock.ts';
import { ID_GENERATOR } from '../application/ports/id-generator.ts';
import { APP_CONFIG, loadAppConfig } from './config/app-config.ts';
import { SystemClock, UuidV7Generator } from './system-providers.ts';

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadAppConfig() },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
  ],
  exports: [APP_CONFIG, CLOCK, ID_GENERATOR],
})
export class SharedModule {}
