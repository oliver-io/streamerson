import {EventEmitter} from 'events';

export class GracefulShutdown extends EventEmitter {
  constructor(private cleanFn: (e: any) => Promise<any>) {
    super();

    process.on('exit', this.handleExit.bind(this, 0));
    process.on('SIGTERM', this.handleExit.bind(this, 143)); // SIGTERM default exit code is 143
    process.on('SIGINT', this.handleExit.bind(this, 130));  // SIGINT default exit code is 130
    process.on('SIGHUP', this.handleExit.bind(this, 129));  // SIGHUP default exit code is 129
  }

  private async cleanup(e: any): Promise<void> {
    console.log('Running cleanup script...');
    await this.cleanFn(e);
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log('Cleanup done!');
  }

  private async handleExit(exitCode: number): Promise<void> {
    try {
      await this.cleanup(exitCode);
      this.emit('cleaned', exitCode);
      process.exit(exitCode);
    } catch (err) {
      console.error('Error during cleanup:', err);
      process.exit(1);
    }
  }
}
