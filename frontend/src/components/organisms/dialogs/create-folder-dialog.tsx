'use client';

import React, { useState, useEffect } from 'react';
import { FolderPlus } from 'lucide-react';
import { useI18n } from '@/providers/i18n-context';
import Modal from '@/components/molecules/modal';
import TextInput from '@/components/atoms/text-input';
import Button from '@/components/atoms/button';
import FieldError from '@/components/atoms/field-error';

interface CreateFolderDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (name: string) => Promise<void> | void;
  error?: string;
  onClearError?: () => void;
}

export default function CreateFolderDialog({ isOpen, onClose, onConfirm, error, onClearError }: CreateFolderDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setIsSubmitting(false);
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onConfirm(name.trim());
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      titleNode={
        <h2 className="font-semibold text-gray-800 flex items-center gap-2">
          <FolderPlus size={20} className="text-blue-500" />
          {t('createFolder.title')}
        </h2>
      }
    >
      <form onSubmit={handleSubmit}>
        <TextInput
          value={name}
          onChange={(e) => { setName(e.target.value); if (error) onClearError?.(); }}
          placeholder={t('createFolder.placeholder')}
          error={!!error}
          autoFocus
        />
        <FieldError message={error} />
        <div className="flex justify-end gap-2 mt-6">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('createFolder.cancel')}
          </Button>
          <Button type="submit" disabled={!name.trim() || !!error} loading={isSubmitting}>
            {t('createFolder.create')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
