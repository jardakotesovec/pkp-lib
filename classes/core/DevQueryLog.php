<?php

/**
 * @file classes/core/DevQueryLog.php
 *
 * Copyright (c) 2014-2026 Simon Fraser University
 * Copyright (c) 2000-2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class DevQueryLog
 *
 * @brief Development-only per-request query counter. Enabled by setting the
 *   environment variable PKP_QUERY_LOG to a writable file path; each request
 *   (or CLI run) appends one JSON line with its query count, cumulative DB
 *   time and peak memory. Set PKP_QUERY_LOG_SQL=1 to also capture every SQL
 *   statement with its bindings and duration.
 */

namespace PKP\core;

use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Support\Facades\DB;

class DevQueryLog
{
    protected static bool $registered = false;
    protected static int $count = 0;
    protected static float $timeMs = 0.0;
    protected static array $queries = [];

    public static function register(string $logFile): void
    {
        // The provider boot code can run more than once (PKP and APP providers)
        if (static::$registered) {
            return;
        }
        static::$registered = true;

        $captureSql = (bool) getenv('PKP_QUERY_LOG_SQL');
        $tracePattern = getenv('PKP_QUERY_LOG_TRACE') ?: null;

        DB::listen(function (QueryExecuted $query) use ($captureSql, $tracePattern) {
            static::$count++;
            static::$timeMs += $query->time;
            if ($captureSql) {
                $entry = ['sql' => $query->sql, 'ms' => $query->time];
                if ($tracePattern && preg_match('/' . $tracePattern . '/', $query->sql)) {
                    $entry['trace'] = collect(debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 40))
                        ->filter(fn ($frame) => isset($frame['file']) && !str_contains($frame['file'], '/lib/vendor/'))
                        ->map(fn ($frame) => basename(dirname($frame['file'])) . '/' . basename($frame['file']) . ':' . $frame['line'])
                        ->values()
                        ->take(12)
                        ->all();
                }
                static::$queries[] = $entry;
            }
        });

        register_shutdown_function(function () use ($logFile, $captureSql) {
            $entry = [
                'time' => date('c'),
                'request' => $_SERVER['REQUEST_URI'] ?? implode(' ', $_SERVER['argv'] ?? ['cli']),
                'queries' => static::$count,
                'dbMs' => round(static::$timeMs, 1),
                'peakMemMb' => round(memory_get_peak_usage(true) / 1048576, 1),
            ];
            if ($captureSql) {
                $entry['sql'] = static::$queries;
            }
            file_put_contents($logFile, json_encode($entry) . "\n", FILE_APPEND | LOCK_EX);
        });
    }
}
