{**
 * templates/controllers/grid/dataCitations/form/dataCitationForm.tpl
 *
 * Copyright (c) 2014-2025 Simon Fraser University
 * Copyright (c) 2003-2025 John Willinsky
 * Distributed under the GNU GPL v3. For full terms see the file docs/COPYING.
 *
 * Form to add/edit a data citation.
 *}

<script type="text/javascript">
	$(function() {ldelim}
		// Attach the form handler.
		$('#dataCitationForm').pkpHandler('$.pkp.controllers.form.AjaxFormHandler');
	{rdelim});	
</script>
<form class="pkp_form" id="dataCitationForm" method="post" action="{url op="updateDataCitation" submissionId=$submissionId publicationId=$publicationId dataCitationId=$dataCitationId}">
	{csrf}
	{fbvFormArea id="dataCitation"}
		{fbvFormSection title="submission.dataCitation.title" required=true}
			{fbvElement type="text" label="submission.dataCitation.title.description" value=$title id="title" size=$fbvStyles.size.MEDIUM inline=true disabled=$formDisabled}
		{/fbvFormSection}
		{fbvFormSection title="submission.dataCitation.persistentIdentifier" required=true }
			{fbvElement type="text" label="submission.dataCitation.persistentIdentifier.description" value=$persistentIdentifier id="persistentIdentifier" size=$fbvStyles.size.MEDIUM inline=true disabled=$formDisabled}
		{/fbvFormSection}
	{/fbvFormArea}
	{fbvFormButtons submitText="common.save" submitDisabled=$formDisabled hideCancel=$formDisabled}
</form>
