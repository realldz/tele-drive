'use client';

import React, { useState, useEffect } from 'react';
import { useI18n } from '@/providers/i18n-context';
import Modal from '@/components/molecules/modal';
import TextInput from '@/components/atoms/text-input';
import Button from '@/components/atoms/button';
import FieldError from '@/components/atoms/field-error';

interface RenameDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (newName: string) => Promise<void> | void;
  initialName: string;
  itemType: 'file' | 'folder';
  error?: string;
  onClearError?: () => void;
}

export default function RenameDialog({ isOpen, onClose, onConfirm, initialName, itemType, error, onClearError }: RenameDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState(initialName);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Sync name state when dialog opens with a different item
  useEffect(() => {
    if (isOpen) {
      setName(initialName); // eslint-disable-line react-hooks/set-state-in-effect
    }
  }, [isOpen, initialName]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim() && name !== initialName) {
      setIsSubmitting(true);
      await onConfirm(name.trim());
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      title={t(itemType === 'file' ? 'rename.titleFile' : 'rename.titleFolder')}
    >
      <form onSubmit={handleSubmit}>
        <TextInput
          value={name}
          onChange={(e) => { setName(e.target.value); if (error) onClearError?.(); }}
          error={!!error}
          autoFocus
        />
        <FieldError message={error} />
        <div className="flex justify-end gap-2 mt-6">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('rename.cancel')}
          </Button>
          <Button type="submit" disabled={!name.trim() || name === initialName || !!error} loading={isSubmitting}>
            {t('rename.confirm')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
