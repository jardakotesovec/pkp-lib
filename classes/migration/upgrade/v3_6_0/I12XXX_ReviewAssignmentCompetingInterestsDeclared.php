<?php

/**
 * @file classes/migration/upgrade/v3_6_0/I12XXX_ReviewAssignmentCompetingInterestsDeclared.php
 * Copyright (c) 2026 Simon Fraser University
 * Copyright (c) 2026 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * @class I12XXX_ReviewAssignmentCompetingInterestsDeclared.php
 *
 * @brief Add competing_interests_declared column to review_assignments table.
 */

namespace PKP\migration\upgrade\v3_6_0;

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use PKP\migration\Migration;

class I12XXX_ReviewAssignmentCompetingInterestsDeclared extends Migration
{
    public function up(): void
    {
        Schema::table('review_assignments', function (Blueprint $table) {
            $table->boolean('competing_interests_declared')->default(false)->comment('Whether the reviewer answered the competing interests declaration; false for reviews completed before the context enabled it.');
        });
    }

    public function down(): void
    {
        Schema::table('review_assignments', function (Blueprint $table) {
            $table->dropColumn('competing_interests_declared');
        });
    }
}
