export interface RedisClassification {
  command: string;
  operation: "read" | "write" | "unknown";
  write: boolean;
}

const READ_COMMANDS = new Set(["GET", "MGET", "HGET", "EXISTS", "TTL"]);
const WRITE_COMMANDS = new Set(["SET", "DEL", "HSET", "INCR", "EXPIRE", "MSET"]);

export function classifyRedisCommand(command: string): RedisClassification {
  const upper = command.toUpperCase();

  if (READ_COMMANDS.has(upper)) {
    return {
      command: upper,
      operation: "read",
      write: false,
    };
  }

  if (WRITE_COMMANDS.has(upper)) {
    return {
      command: upper,
      operation: "write",
      write: true,
    };
  }

  return {
    command: upper,
    operation: "unknown",
    write: false,
  };
}

