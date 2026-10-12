// Stand-in fenced cron Worker for the staging edge's EP-8 drill (STG-DRV).
// Each scheduled run writes one heartbeat row to the catch-up control D1, so
// the fence's quiescence proof sees real D1 writes and invocations before
// apply and none after it. It reads no other binding, serves no request and
// stores only the cron expression and the scheduled time. The module exports
// only its handler: workerd refuses a named export that is not a handler.
const HEARTBEAT_SQL =
  "INSERT INTO staging_edge_heartbeat (scheduled_at_ms, cron) VALUES (?1, ?2)";

export default {
  async scheduled(controller, env) {
    await env.STORAGE_ANALYTICS_CATCHUP_CONTROL_DB.prepare(HEARTBEAT_SQL)
      .bind(controller.scheduledTime, controller.cron)
      .run();
  },
};
