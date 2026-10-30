import { ServiceError, type BoardService } from './types';

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new ServiceError('请求已取消。', 'CANCELLED')); return; }
    const cancel = () => { clearTimeout(timer); reject(new ServiceError('请求已取消。', 'CANCELLED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, milliseconds);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

// A successful GET is only a cache read. A completed refresh job proves collection.
export async function refreshSession(service: BoardService, id: string, signal: AbortSignal) {
  let job = await service.requestSessionRefresh(id, signal);
  // Allow one in-flight host read plus the directed read (up to 65s each).
  // This only bounds UI waiting; timing out must not claim the job failed.
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new ServiceError('请求已取消。', 'CANCELLED');
    if (job.status === 'failed') throw new ServiceError(job.error?.message ?? '重新检查失败，保留上次内容。', 'REFRESH_FAILED');
    if (job.status === 'succeeded') {
      const detail = await service.getSession(id, signal);
      const required = job.collectionVersion;
      const actual = detail.collectionVersion;
      if (!required || !actual || required.epoch !== actual.epoch) throw new ServiceError('服务已重启或缺少采集版本，请重新检查。', 'VERSION_CHANGED');
      if (actual.sequence >= required.sequence) return detail;
    }
    await wait(service.mode === 'mock' ? 0 : 1000, signal);
    job = await service.getRefresh(job.id, signal);
  }
  throw new ServiceError('等待刷新结果超时，作业可能仍在执行；保留上次内容，可稍后重试。', 'REFRESH_TIMEOUT');
}
